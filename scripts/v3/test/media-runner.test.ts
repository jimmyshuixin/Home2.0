import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import sharp from 'sharp';
import { MEDIA_LIMITS } from '@xvyin/contracts';
import { Processing } from '../../../workers/api/src/processing';
import { MemoryStore } from '../../../workers/api/src/store/memory';
import type { MediaAsset, Quota } from '../../../workers/api/src/media';
import { ApiError } from '../../../workers/api/src/errors';
import { sha256 } from '../../../workers/api/src/security';
import { runMedia, type MediaRunnerClient } from '../media-runner';

const instant = Date.UTC(2026, 8, 12), runId = 'test-runner-identity';
let root: string, mf: Miniflare, bucket: R2Bucket, store: MemoryStore, processing: Processing;
beforeAll(async () => { root = await mkdtemp(resolve(tmpdir(), 'xvyin-runner-test-')); mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default{fetch(){return new Response("test")}}', compatibilityDate: '2026-09-11', r2Buckets: ['MEDIA'] }), telemetry: { enabled: false }, cf: false }); bucket = await mf.getR2Bucket('MEDIA') as unknown as R2Bucket; });
beforeEach(() => { store = new MemoryStore(); processing = new Processing(store, bucket, () => instant); });
afterAll(async () => { await mf?.dispose(); sharp.cache(false); const path = relative(resolve(tmpdir()), root); if (path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
async function seed(id: string, valid = true) {
  const path = resolve(root, `${id}.png`);
  if (valid) await sharp({ create: { width: 80, height: 60, channels: 3, background: '#345344' } }).png().toFile(path); else await writeFile(path, 'invalid image');
  const bytes = new Uint8Array(await readFile(path)), hash = await sha256(bytes), key = `originals/${id}/source`;
  await bucket.put(key, bytes);
  const asset: MediaAsset = { id, kind: 'image', originalName: 'test.png', originalKey: key, originalBytes: bytes.length, expectedMime: 'image/png', expectedSha256: hash, status: 'processing', variants: [], createdAt: new Date(instant).toISOString(), updatedAt: new Date(instant).toISOString() };
  await store.transaction(async tx => { tx.put(`media/${id}`, asset); tx.put('system/media_quota', { usedBytes: bytes.length, reservedBytes: 0, limitBytes: MEDIA_LIMITS.totalBytes }); });
  return asset;
}
function client(options: { loseResponses?: boolean; rejectSource?: boolean } = {}): MediaRunnerClient {
  const lost = new Set<string>();
  return { async request(path, init = {}) {
    const match = /^\/api\/v1\/internal\/processing\/([^/]+)\/(.+)$/.exec(path); if (!match) throw new Error('unexpected endpoint');
    const id = match[1]!, action = match[2]!, request = new Request(`https://private.test${path}`, init);
    let data: unknown;
    try {
      if (action === 'claim') data = await processing.claim(id, runId);
      else if (action === 'source') { if (options.rejectSource) throw new Error('simulated connection loss'); return processing.source(id, runId, request); }
      else if (action === 'plan') data = await processing.plan(id, runId, await request.json());
      else if (action === 'status') data = processing.publicJob(await processing.get(id, runId));
      else if (action.startsWith('parts/')) { const [, role, part] = action.split('/'); data = await processing.part(id, runId, role!, Number(part), request); }
      else if (action.startsWith('complete/')) data = await processing.completeVariant(id, runId, action.split('/')[1]!);
      else if (action === 'finish') data = await processing.finish(id, runId);
      else if (action === 'fail') { await processing.fail(id, runId, await request.json() as { code: string; message: string }); data = { failed: true }; }
      else throw new Error('unexpected action');
    } catch (error) { if (error instanceof ApiError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status }); throw error; }
    if (options.loseResponses && (action.startsWith('parts/') || action.startsWith('complete/') || action === 'finish') && !lost.has(action)) { lost.add(action); throw new Error('simulated lost acknowledgement after successful commit'); }
    return Response.json({ data });
  } };
}
describe('media runner end to end with real image decoder and R2', () => {
  it('recovers lost part/complete/finish responses and never double counts quota', async () => {
    const asset = await seed('runner-image');
    expect(await runMedia({ assetId: asset.id, client: client({ loseResponses: true }), privateRoot: resolve(root, 'private') })).toEqual({ assetId: asset.id, status: 'ready' });
    const ready = (await store.get<MediaAsset>(`media/${asset.id}`))!; expect(ready.status).toBe('ready'); expect(ready.variants).toHaveLength(3);
    const quota = (await store.get<Quota>('system/media_quota'))!; expect(quota.usedBytes).toBe(asset.originalBytes + ready.variants.reduce((sum, variant) => sum + variant.bytes, 0)); expect(quota.reservedBytes).toBe(0);
    expect(await runMedia({ assetId: asset.id, client: client(), privateRoot: resolve(root, 'private') })).toEqual({ assetId: asset.id, status: 'ready' });
    expect(await store.get<Quota>('system/media_quota')).toEqual(quota);
  });
  it('marks an actually invalid image failed without producing publishable variants', async () => {
    const asset = await seed('invalid-image', false);
    await expect(runMedia({ assetId: asset.id, client: client(), privateRoot: resolve(root, 'private-invalid') })).rejects.toMatchObject({ code: 'UPLOAD_TYPE_MISMATCH' });
    expect((await store.get<MediaAsset>(`media/${asset.id}`))!.status).toBe('failed');
    expect((await store.get<Quota>('system/media_quota'))!.usedBytes).toBe(asset.originalBytes);
  });
  it('keeps interrupted downloads resumable instead of marking media failed', async () => {
    const asset = await seed('retry-image');
    await expect(runMedia({ assetId: asset.id, client: client({ rejectSource: true }), privateRoot: resolve(root, 'private-retry') })).rejects.toThrow('simulated connection loss');
    expect((await processing.get(asset.id, runId)).state).toBe('claimed');
    expect((await store.get<MediaAsset>(`media/${asset.id}`))!.status).toBe('processing');
    expect((await runMedia({ assetId: asset.id, client: client(), privateRoot: resolve(root, 'private-retry') })).status).toBe('ready');
  });
});
