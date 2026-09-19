import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import type { PhotographyMetadata } from '@xvyin/contracts';
import { photographyRunnerCli, runPhotographyBackfill, type PhotographyRunnerClient } from '../photo-metadata-runner';

const prefix = '/api/v1/internal/photography';
type Fixture = { id: string; bytes: number; mime: 'image/jpeg' | 'image/png' | 'image/webp'; sha256: string; sourceUrl: string; original: Buffer };
let root: string;
beforeAll(async () => { root = await mkdtemp(resolve(tmpdir(), 'xvyin-photography-test-')); });
afterAll(async () => {
  sharp.cache(false);
  const rel = relative(resolve(tmpdir()), root);
  if (rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const hash = (buffer: Uint8Array) => createHash('sha256').update(buffer).digest('hex');
async function fixture(id: string, format: 'jpeg' | 'png' | 'webp' = 'jpeg', exif = true, timestamp = '2024:02:29 23:59:58'): Promise<Fixture> {
  let source = sharp({ create: { width: 32, height: 24, channels: 3, background: '#123456' } });
  if (exif) source = source.withExif({ IFD0: { Make: 'Sony', Model: 'ILCE-7RM5', Artist: 'PRIVATE OWNER' }, IFD2: { DateTimeOriginal: timestamp, ExposureTime: '1/250', FNumber: '28/10', ISOSpeedRatings: '400', FocalLength: '85/1', LensModel: 'FE 85mm F1.8', BodySerialNumber: 'PRIVATE SERIAL' }, IFD3: { GPSLatitude: '31/1 12/1 0/1', GPSLongitude: '121/1 30/1 0/1' } });
  const original = await source.toFormat(format).toBuffer();
  return { id, bytes: original.length, mime: `image/${format}`, sha256: hash(original), sourceUrl: `${prefix}/${id}/source`, original };
}
function remote(items: Fixture[], options: { failSource?: Set<string>; failComplete?: Set<string>; alreadyDone?: Set<string>; pages?: Array<{ items: Fixture[]; scanned: number; nextCursor: string | null }> } = {}) {
  const posted = new Map<string, { sha256: string; photography: PhotographyMetadata | null }>(), requests: Array<{ path: string; method: string }> = [];
  let page = 0, active = 0, maxActive = 0;
  const client: PhotographyRunnerClient = { async request(path, init = {}) {
    requests.push({ path, method: init.method || 'GET' }); active++; maxActive = Math.max(maxActive, active);
    try {
      if (path === prefix || path.startsWith(`${prefix}?`)) {
        const data = options.pages?.[page++] ?? { items, scanned: items.length, nextCursor: null };
        return Response.json({ data: { ...data, items: data.items.map(({ original: _original, ...item }) => item) } });
      }
      const found = items.find(item => path === item.sourceUrl || path === `${prefix}/${item.id}/complete`);
      if (!found) throw new Error('Unexpected endpoint, variants are forbidden in this test');
      if (path.endsWith('/source')) {
        if (options.failSource?.has(found.id)) throw new Error('PRIVATE provider error, cookie, filename.jpg');
        // Deliberately chunk the stream so the hash and awaited disk writer are exercised.
        let offset = 0;
        return new Response(new ReadableStream({ pull(controller) { const chunk = found.original.subarray(offset, offset + 97); offset += chunk.length; if (chunk.length) controller.enqueue(chunk); else controller.close(); } }));
      }
      expect(init.method).toBe('POST');
      if (options.failComplete?.has(found.id)) return Response.json({ error: { code: 'SOURCE_CHANGED', message: 'PRIVATE filename.jpg' } }, { status: 409 });
      const body = JSON.parse(String(init.body)); posted.set(found.id, body);
      return Response.json({ data: { status: options.alreadyDone?.has(found.id) ? 'already_done' : body.photography ? 'updated' : 'no_exif' } });
    } finally { active--; }
  } };
  return { client, posted, requests, maxActive: () => maxActive };
}
async function diskReport(privateRoot: string) {
  const dirs = await readdir(privateRoot); expect(dirs).toHaveLength(1);
  const path = resolve(privateRoot, dirs[0]!); expect(await readdir(path)).toEqual(['report.json']);
  return JSON.parse(await readFile(resolve(path, 'report.json'), 'utf8'));
}

describe('photography backfill with real JPEG, PNG and WebP EXIF', () => {
  it('reads original EXIF serially, sends only safe tags and does not rewrite originals or upload variants', async () => {
    const items = await Promise.all((['jpeg', 'png', 'webp'] as const).map(format => fixture(`camera-${format}`, format))), service = remote(items);
    const before = items.map(item => hash(item.original)), privateRoot = resolve(root, 'three-containers');
    const report = await runPhotographyBackfill({ client: service.client, privateRoot });
    expect(report).toMatchObject({ status: 'complete', scanned: 3, attempted: 3, updated: 3, failed: 0 });
    for (const item of items) {
      expect(service.posted.get(item.id)).toEqual({ sha256: item.sha256, photography: { cameraMake: 'Sony', cameraModel: 'ILCE-7RM5', lensModel: 'FE 85mm F1.8', focalLengthMm: 85, exposureSeconds: 1 / 250, aperture: 2.8, iso: 400, takenAt: '2024-02-29T23:59:58', takenDate: '2024-02-29' } });
    }
    expect(items.map(item => hash(item.original))).toEqual(before); expect(service.maxActive()).toBe(1);
    expect(service.requests.every(request => request.path === prefix || request.path.endsWith('/source') || request.path.endsWith('/complete'))).toBe(true);
    expect(JSON.stringify([...service.posted.values()])).not.toMatch(/PRIVATE|GPS|serial/iu);
    expect(await diskReport(privateRoot)).toEqual(report);
  });
  it('records missing metadata without inventing capture dates and handles an idempotent replay', async () => {
    const items = [await fixture('stripped', 'png', false), await fixture('bad-clock', 'webp', true, '2023:02:29 27:00:00'), await fixture('completed')], service = remote(items, { alreadyDone: new Set(['completed']) });
    const report = await runPhotographyBackfill({ client: service.client, privateRoot: resolve(root, 'missing') });
    expect(report).toMatchObject({ status: 'complete', no_exif: 1, updated: 1, already_done: 1, skipped: 1 });
    expect(service.posted.get('stripped')?.photography).toBeNull();
    expect(service.posted.get('bad-clock')?.photography).toMatchObject({ cameraMake: 'Sony' });
    expect(service.posted.get('bad-clock')?.photography?.takenDate).toBeUndefined();
  });
  it('continues after corrupt/hash/size/type/network/API failures and saves only sanitized evidence', async () => {
    const items = await Promise.all(['corrupt', 'hash-bad', 'short', 'oversize', 'type-bad', 'network-bad', 'conflict', 'valid'].map(id => fixture(id)));
    items[0]!.original = Buffer.from('not a real JPEG'); items[0]!.bytes = items[0]!.original.length; items[0]!.sha256 = hash(items[0]!.original);
    items[1]!.sha256 = '0'.repeat(64); items[2]!.bytes++; items[3]!.bytes--; items[4]!.mime = 'image/png';
    const service = remote(items, { failSource: new Set(['network-bad']), failComplete: new Set(['conflict']) }), events: unknown[] = [], privateRoot = resolve(root, 'failures');
    const report = await runPhotographyBackfill({ client: service.client, privateRoot, log: event => events.push(event) });
    expect(report).toMatchObject({ status: 'failed', attempted: 8, updated: 1, failed: 7 });
    expect(report.results.map(item => item.code)).toEqual(['PHOTOGRAPHY_RUNNER_FAILED', 'SOURCE_HASH_MISMATCH', 'SOURCE_SIZE_MISMATCH', 'SOURCE_SIZE_MISMATCH', 'SOURCE_TYPE_MISMATCH', 'PHOTOGRAPHY_RUNNER_FAILED', 'SOURCE_CHANGED', undefined]);
    expect([...service.posted.keys()]).toEqual(['valid']);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|cookie|filename|ILCE|sha256/u);
    expect(await diskReport(privateRoot)).toEqual(report);
  });
  it('follows pagination through empty filtered pages and prevents repeated cursors', async () => {
    const item = await fixture('page-two'), service = remote([item], { pages: [{ items: [], scanned: 20, nextCursor: 'next-20' }, { items: [item], scanned: 1, nextCursor: 'next-20' }] });
    const report = await runPhotographyBackfill({ client: service.client, privateRoot: resolve(root, 'cursor') });
    expect(report).toMatchObject({ scanned: 21, updated: 1, skipped: 20, status: 'failed', errorCode: 'REPEATED_CURSOR' });
    expect(service.requests.filter(request => !request.path.endsWith('/source') && !request.path.endsWith('/complete'))).toHaveLength(2);
  });
  it('stops before requesting another page beyond the scan budget and reports incomplete work', async () => {
    const service = remote([], { pages: [{ items: [], scanned: 20, nextCursor: 'more' }] });
    const report = await runPhotographyBackfill({ client: service.client, privateRoot: resolve(root, 'cap'), maxScanned: 20 });
    expect(report).toMatchObject({ status: 'failed', scanned: 20, errorCode: 'SCAN_LIMIT_REACHED' }); expect(service.requests).toHaveLength(1);
  });
  it('rejects source URL substitution before any download or metadata write', async () => {
    const item = await fixture('injected'); item.sourceUrl = 'https://untrusted.invalid/private';
    const service = remote([item]), report = await runPhotographyBackfill({ client: service.client, privateRoot: resolve(root, 'source-url') });
    expect(report.results).toEqual([{ assetId: item.id, status: 'failed', code: 'SOURCE_URL_REJECTED' }]); expect(service.requests).toHaveLength(1);
  });
  it('rejects a partial source response and a failing list response without claiming success', async () => {
    const item = await fixture('partial'), base = remote([item]);
    const client: PhotographyRunnerClient = { request: (path, init) => path.endsWith('/source') ? Promise.resolve(new Response(new Uint8Array(item.original), { status: 206 })) : base.client.request(path, init) };
    expect((await runPhotographyBackfill({ client, privateRoot: resolve(root, 'partial') })).results[0]).toMatchObject({ status: 'failed', code: 'SOURCE_PARTIAL_RESPONSE' });
    const failed = await runPhotographyBackfill({ client: { request: async () => Response.json({ error: { code: 'AUTH_REQUIRED', message: 'PRIVATE' } }, { status: 401 }) }, privateRoot: resolve(root, 'list-failure') });
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'AUTH_REQUIRED', attempted: 0 });
  });
  it('keeps CLI arguments and origin validation mandatory without needing credentials', async () => {
    await expect(photographyRunnerCli([])).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    await expect(photographyRunnerCli(['--origin', 'https://untrusted.invalid'])).rejects.toMatchObject({ code: 'INVALID_ORIGIN' });
  });
});
