import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { AlbumDraftSchema, type AlbumPhotoDraft, type PhotoMapSettings } from '@xvyin/contracts';
import { Releases, type ReleaseJob } from '../src/releases';
import { Records } from '../src/records';
import { MemoryStore } from '../src/store/memory';
import type { MediaAsset } from '../src/media';
import type { Store } from '../src/store/types';
import { publicSnapshot } from '../../../apps/web/lib/build-snapshot';
import { createApi } from '../src/app';
import type { AuthProvider } from '../src/auth';
import { ApiError } from '../src/errors';

const now = Date.UTC(2026, 8, 27), codeSha = 'a'.repeat(40), runId = 'photo-map-run';
const gps = { latitude: 31.123456, longitude: 121.654321 };
let mf: Miniflare, bucket: R2Bucket, memory: MemoryStore, releases: Releases, records: Records;
let batches: number[], readKeys: string[], loseLocationProgress: boolean;
beforeAll(async () => {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("fixture"); } }', compatibilityDate: '2026-09-11', r2Buckets: ['MEDIA'] }), telemetry: { enabled: false }, cf: false });
  bucket = await mf.getR2Bucket('MEDIA') as unknown as R2Bucket;
});
afterAll(async () => { await mf.dispose(); });
beforeEach(async () => {
  let cursor: string | undefined;
  do { const page = await bucket.list({ cursor }); if (page.objects.length) await bucket.delete(page.objects.map(item => item.key)); cursor = page.truncated ? page.cursor : undefined; } while (cursor);
  memory = new MemoryStore(); batches = []; readKeys = []; loseLocationProgress = false;
  const store: Store = { get: async <T>(key: string) => { readKeys.push(key); return memory.get<T>(key); }, getMany: async <T>(keys: readonly string[]) => { batches.push(keys.length); readKeys.push(...keys); return memory.getMany<T>(keys); }, list: memory.list.bind(memory), transaction: memory.transaction.bind(memory) };
  const resumableBucket = new Proxy(bucket, { get(target, property) {
    const member = Reflect.get(target, property);
    if (typeof member !== 'function') return member;
    return async (...args: unknown[]) => {
      const result = await Reflect.apply(member, target, args);
      if (property === 'put' && String(args[0]).startsWith('private-snapshot-preparation/') && loseLocationProgress) { loseLocationProgress = false; throw new Error('lost location progress response'); }
      return result;
    };
  } });
  releases = new Releases(store, resumableBucket, () => now, codeSha); records = new Records(memory, () => now);
});
async function asset(id: string, capture = gps): Promise<void> {
  const at = new Date(now).toISOString();
  const value: MediaAsset = { id, kind: 'image', originalName: 'private.jpg', originalKey: `originals/${id}`, originalBytes: 100, expectedMime: 'image/jpeg', status: 'ready', createdAt: at, updatedAt: at,
    metadata: { kind: 'image', detectedMime: 'image/jpeg', bytes: 100, sha256: 'b'.repeat(64), width: 100, height: 100, photography: { cameraModel: 'Test camera' }, ...({ gps: capture } as object) },
    variants: [{ role: 'content', url: `/api/v1/media/${id}/content`, key: `variants/${id}/content`, mime: 'image/webp', bytes: 100, sha256: 'b'.repeat(64), width: 100, height: 100 }] };
  await memory.transaction(async tx => tx.put(`media/${id}`, value));
}
const photo = (id: string, assetId: string, map?: Partial<PhotoMapSettings>, status = 'published') => ({ id, assetId, alt: id, status, ...(map ? { map } : {}) });
async function publish(photos: unknown[], options: { id?: string; version?: number; expectedReleaseId?: string | null; slug?: string } = {}) {
  const record = await records.save('albums', AlbumDraftSchema, { title: 'Map fixture', slug: options.slug || 'map-fixture', photos }, 'admin', options.id, options.version || 0);
  const job = await releases.create({ changes: [{ collection: 'albums', id: record.id, version: record.version, action: 'publish' }], expectedReleaseId: options.expectedReleaseId || null }, 'admin');
  await releases.claim(job.id, runId, codeSha); return { record, job };
}
async function prepare(job: ReleaseJob) {
  let result = job;
  for (let i = 0; result.snapshotPrepared === false && i < 20; i++) { batches = []; result = await releases.prepareSnapshot(job.id, runId); expect(batches.every(count => count <= 100)).toBe(true); expect(batches.length).toBeLessThanOrEqual(1); }
  expect(result.snapshotPrepared).toBe(true); return releases.snapshot(job.id);
}
async function activateFixture(job: ReleaseJob) {
  await bucket.put('active-release.json', JSON.stringify({ releaseId: job.id, manifestSha256: 'c'.repeat(64), activatedAt: new Date(now).toISOString(), schemaVersion: 1, codeSha, runId }));
}

describe('per-photo map publication and frozen location preparation', () => {
  it('keeps unfinished private sources inaccessible to anonymous clients and other runners', async () => {
    for (let i = 0; i < 101; i++) await asset(`auth-${i}`);
    const { job } = await publish(Array.from({ length: 101 }, (_, i) => photo(`photo-${i}`, `auth-${i}`, { visibility: 'exact', source: 'exif' })));
    const origin = 'https://site.invalid';
    const api = createApi({ store: memory, bucket, auth: {} as AuthProvider, now: () => now, privacySalt: 'test-only-salt-01234567890123456789', secureCookies: true, allowedOrigins: [origin], adminUsername: 'test', codeSha,
      verifyRunner: async request => { const authorization = request.headers.get('authorization'); if (!['Bearer allowed', 'Bearer other'].includes(authorization || '')) throw new ApiError('RUNNER_UNAUTHORIZED', 403, 'denied'); return { runId: authorization === 'Bearer allowed' ? runId : 'other-run', codeSha }; } });
    for (const suffix of ['snapshot', 'prepare']) {
      const method = suffix === 'prepare' ? 'POST' : 'GET';
      for (const authorization of [undefined, 'Bearer invalid', 'Bearer other']) {
        const response = await api.app.fetch(new Request(`${origin}/api/v1/internal/releases/${job.id}/${suffix}`, { method, headers: { origin, ...(authorization ? { authorization } : {}) } }));
        expect([401, 403]).toContain(response.status); expect(await response.text()).not.toContain('pendingPhotoLocations');
      }
    }
    const unfinished = await api.app.fetch(new Request(`${origin}/api/v1/internal/releases/${job.id}/snapshot`, { headers: { authorization: 'Bearer allowed' } }));
    expect(unfinished.status).toBe(409);
    const source = await api.app.fetch(new Request(`${origin}/private-snapshot-sources/${job.id}.json`));
    expect(source.ok).toBe(false); expect(await source.text()).not.toContain('pendingPhotoLocations');
    await prepare(job);
    const ready = await api.app.fetch(new Request(`${origin}/api/v1/internal/releases/${job.id}/snapshot`, { headers: { authorization: 'Bearer allowed' } }));
    expect(ready.status).toBe(200); const content = await ready.text(); expect(content).not.toContain('pendingPhotoLocations'); expect(content).not.toContain('"map"');
  });
  it('publishes only chosen reference locations and retains private choices solely in revisions', async () => {
    await asset('shared');
    const city = { latitude: 30, longitude: 120, label: 'Chosen city centre' };
    const { record, job } = await publish([
      photo('hidden', 'shared', { visibility: 'hidden', coordinates: { latitude: 44.333333, longitude: 66.444444 } }),
      photo('city', 'shared', { visibility: 'city', source: 'exif', city }),
      photo('exact', 'shared', { visibility: 'exact', source: 'exif' }),
      photo('manual', 'shared', { visibility: 'exact', source: 'manual', coordinates: { latitude: 0, longitude: -20 }, label: 'Manual point' }),
      photo('draft', 'shared', { visibility: 'exact', source: 'exif' }, 'draft'),
    ]);
    const snapshot = await prepare(job), output = JSON.stringify(snapshot), photos = snapshot.albums[0]!.photos;
    expect(photos.map(item => item.id)).toEqual(['hidden', 'city', 'exact', 'manual']);
    expect(photos[0]).not.toHaveProperty('location');
    expect(photos[1]!.location).toEqual({ ...city, precision: 'city' });
    expect(photos[2]!.location).toEqual({ ...gps, precision: 'exact' });
    expect(photos[3]!.location).toEqual({ latitude: 0, longitude: -20, label: 'Manual point', precision: 'exact' });
    expect(snapshot.assets[0]).not.toHaveProperty('gps'); expect(snapshot.assets[0]!.photography).not.toHaveProperty('gps');
    expect(output).not.toContain('44.333333'); expect(output).not.toContain('"map"'); expect(output).not.toContain('pendingPhotoLocations');
    expect(publicSnapshot(snapshot).albums[0]!.photos).toEqual(photos);
    expect((await memory.get<{ data: { photos: AlbumPhotoDraft[] } }>(`revisions/${record.draftRevisionId}`))!.data.photos[0]!.map?.coordinates?.latitude).toBe(44.333333);
  });
  it('keeps EXIF-missing photos publishable and blocks incomplete city/manual public choices', async () => {
    await asset('no-gps');
    await memory.transaction(async tx => { const saved = await tx.get<MediaAsset>('media/no-gps'); const metadata = { ...saved!.metadata } as Record<string, unknown>; delete metadata.gps; tx.put('media/no-gps', { ...saved, metadata }); });
    const { job } = await publish([photo('unknown', 'no-gps', { visibility: 'exact', source: 'exif' })]);
    expect((await prepare(job)).albums[0]!.photos[0]).not.toHaveProperty('location');
    for (const map of [{ visibility: 'city' }, { visibility: 'city', city: { latitude: 1, longitude: 2, label: '' } }, { visibility: 'exact', source: 'manual' }] as Array<Partial<PhotoMapSettings>>) {
      await expect(publish([photo('incomplete', 'no-gps', map)])).rejects.toMatchObject({ code: 'PUBLISH_VALIDATION' });
    }
  });
  it('resumes many new assets without loading changed drafts or exposing private queues as snapshots', async () => {
    for (let i = 0; i < 205; i++) await asset(`asset-${i}`, { latitude: i / 100, longitude: -(i + 1) / 100 });
    const { record, job } = await publish(Array.from({ length: 205 }, (_, i) => photo(`photo-${i}`, `asset-${i}`, { visibility: 'exact', source: 'exif' })));
    expect(job).toMatchObject({ snapshotPrepared: false, preparedAssetCount: 100, preparedLocationCount: 100, locationCount: 205 });
    await expect(releases.snapshot(job.id)).rejects.toMatchObject({ code: 'RELEASE_NOT_FOUND' });
    await memory.transaction(async tx => tx.put(`albums/${record.id}`, { draft: { photos: [] } }));
    readKeys = []; loseLocationProgress = true;
    await expect(releases.prepareSnapshot(job.id, runId)).rejects.toThrow('lost location progress response');
    const snapshot = await prepare(job);
    expect(snapshot.albums[0]!.photos).toHaveLength(205);
    expect(snapshot.albums[0]!.photos.every(item => item.location?.precision === 'exact')).toBe(true);
    expect(readKeys.some(key => key.startsWith('albums/'))).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('pendingPhotoLocations');
    expect(await releases.prepareSnapshot(job.id, runId)).toMatchObject({ snapshotPrepared: true, preparedLocationCount: 205 });
  });
  it('resolves old public assets in bounded location-only batches and never inherits a removed location', async () => {
    for (let i = 0; i < 305; i++) await asset(`old-${i}`);
    const hidden = Array.from({ length: 305 }, (_, i) => photo(`photo-${i}`, `old-${i}`));
    const first = await publish(hidden); await prepare(first.job); await activateFixture(first.job);
    const exact = hidden.map(item => ({ ...item, map: { visibility: 'exact', source: 'exif' } }));
    const second = await publish(exact, { id: first.record.id, version: first.record.version, expectedReleaseId: first.job.id });
    expect(second.job).toMatchObject({ snapshotPrepared: false, preparedAssetCount: 305, preparedLocationCount: 0, locationCount: 305 });
    const snapshot = await prepare(second.job);
    expect(snapshot.albums[0]!.photos.every(item => item.location?.latitude === gps.latitude)).toBe(true);
    expect((await releases.get(second.job.id)).preparedLocationCount).toBe(305);
    await activateFixture(second.job);
    const third = await publish([photo('photo-0', 'old-0', { visibility: 'hidden', source: 'exif' })], { id: first.record.id, version: second.record.version, expectedReleaseId: second.job.id });
    expect((await prepare(third.job)).albums[0]!.photos[0]).not.toHaveProperty('location');
  });
  it('rebuilds frozen public locations without consulting new GPS or unpublished map edits', async () => {
    await asset('shared');
    const first = await publish([photo('exact', 'shared', { visibility: 'exact', source: 'exif' })]);
    const before = await prepare(first.job); await activateFixture(first.job);
    await asset('shared', { latitude: -11, longitude: -22 });
    await records.save('albums', AlbumDraftSchema, { title: 'PRIVATE LATER', slug: 'private-later', photos: [photo('exact', 'shared', { visibility: 'hidden' })] }, 'admin', first.record.id, first.record.version);
    readKeys = [];
    const job = await releases.create({ changes: [], expectedReleaseId: first.job.id, rebuildPublished: true }, 'admin');
    await releases.claim(job.id, runId, codeSha); const after = await prepare(job);
    expect(after.albums).toEqual(before.albums);
    expect(after.albums[0]!.photos[0]!.location).toEqual({ ...gps, precision: 'exact' });
    expect(readKeys.some(key => key.startsWith('albums/') || key.startsWith('revisions/'))).toBe(false);
  });
});
