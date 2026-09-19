import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { AlbumDraftSchema, CreationDraftSchema, FitnessEntryDraftSchema, FitnessSettingsDraftSchema, PlaylistDraftSchema, SiteSettingsSchema } from '@xvyin/contracts';
import { Releases, type ReleaseJob, type ReleaseManifest, type Snapshot } from '../src/releases';
import { Records } from '../src/records';
import { MemoryStore } from '../src/store/memory';
import type { Store, Transaction } from '../src/store/types';
import type { MediaAsset } from '../src/media';
import { sha256 } from '../src/security';

const instant = Date.UTC(2026, 8, 12, 5), codeSha = 'a'.repeat(40), runId = 'test-preparation-run';
let mf: Miniflare, bucket: R2Bucket, memory: MemoryStore, releases: Releases, operations = 0, batches: number[];
let losePreparationResponse = false;
let readKeys: string[];
beforeAll(async () => {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("local test"); } }', compatibilityDate: '2026-09-11', r2Buckets: ['MEDIA'] }), telemetry: { enabled: false }, cf: false });
  bucket = await mf.getR2Bucket('MEDIA') as unknown as R2Bucket;
});
afterAll(async () => { await mf.dispose(); });
beforeEach(async () => {
  let cursor: string | undefined;
  do { const page = await bucket.list({ cursor }); if (page.objects.length) await bucket.delete(page.objects.map(item => item.key)); cursor = page.truncated ? page.cursor : undefined; } while (cursor);
  memory = new MemoryStore(); operations = 0; batches = []; losePreparationResponse = false; readKeys = [];
  // Count the business-method I/O using the same Firestore protocol costs: begin/read/commit.
  // Authentication/token requests live outside these methods and are deliberately not claimed here.
  const store: Store = {
    get: async <T>(key: string) => { operations++; readKeys.push(key); return memory.get<T>(key); },
    getMany: async <T>(keys: readonly string[]) => { if (keys.length) operations++; readKeys.push(...keys); batches.push(keys.length); return memory.getMany<T>(keys); },
    list: async <T>(collection: string, options?: { limit?: number; cursor?: string }) => { operations++; return memory.list<T>(collection, options); },
    transaction: async <T>(callback: (tx: Transaction) => Promise<T>) => {
      operations++;
      const result = await memory.transaction(tx => callback({ get: async <U>(key: string) => { operations++; readKeys.push(key); return tx.get<U>(key); }, put: tx.put.bind(tx), delete: tx.delete.bind(tx) }));
      operations++; return result;
    },
  };
  const countedBucket = new Proxy(bucket, { get(target, property) {
    const member = Reflect.get(target, property);
    if (typeof member !== 'function') return member;
    return async (...args: unknown[]) => {
      operations++;
      const result = await Reflect.apply(member, target, args);
      if (property === 'put' && String(args[0]).startsWith('private-snapshot-preparation/') && losePreparationResponse) {
        losePreparationResponse = false; throw new Error('test: response lost after real R2 CAS committed');
      }
      return result;
    };
  } });
  releases = new Releases(store, countedBucket, () => instant, codeSha);
});

async function candidate(count = 250): Promise<{ job: ReleaseJob; recordId: string }> {
  const at = new Date(instant).toISOString();
  await memory.transaction(async tx => {
    for (let index = 0; index < count; index++) {
      const id = `asset-${String(index).padStart(5, '0')}`;
      const asset: MediaAsset = { id, kind: 'image', originalName: 'test-only.png', originalKey: `originals/${id}`, originalBytes: 100, expectedMime: 'image/png', status: 'ready', createdAt: at, updatedAt: at,
        variants: [{ role: 'content', url: `/api/v1/media/${id}/content`, key: `variants/${id}/content`, mime: 'image/webp', bytes: 100, sha256: 'b'.repeat(64), width: 1, height: 1 }] };
      tx.put(`media/${id}`, asset);
    }
  });
  const records = new Records(memory, () => instant);
  const record = await records.save('albums', AlbumDraftSchema, { title: 'Frozen original album', slug: 'test-album', photos: Array.from({ length: count }, (_, index) => ({ id: `photo-${index}`, assetId: `asset-${String(index).padStart(5, '0')}`, alt: `Test photo ${index}`, status: 'published' })) }, 'test-admin');
  operations = 0; batches = [];
  const job = await releases.create({ changes: [{ collection: 'albums', id: record.id, version: 1, action: 'publish' }], expectedReleaseId: null }, 'test-admin');
  expect(operations).toBeLessThanOrEqual(14); expect(batches).toEqual([1, Math.min(count, 100)]);
  await releases.claim(job.id, runId, codeSha);
  return { job, recordId: record.id };
}
async function prepare(job: ReleaseJob): Promise<ReleaseJob> {
  let result = job;
  for (let step = 0; result.snapshotPrepared === false && step < 20; step++) {
    operations = 0; batches = []; result = await releases.prepareSnapshot(job.id, runId);
    expect(operations).toBeLessThanOrEqual(12); expect(batches.every(value => value <= 100)).toBe(true); expect(batches.length).toBeLessThanOrEqual(1);
  }
  expect(result.snapshotPrepared).toBe(true); return result;
}
function files() {
  return { files: ['/', '/about/', '/creations/', '/photography/', '/fitness/', '/guestbook/', '/contact/', '/photography/test-album/'].map(path => ({ path: `${path}index.html`, sha256: 'c'.repeat(64), bytes: 200, contentType: 'text/html; charset=utf-8' })) };
}

/** A published pointer fixture for bounded preparation; full activation is covered by integration tests. */
async function publishedCandidate(count: number): Promise<{ before: Snapshot; recordId: string }> {
  const { job, recordId } = await candidate(count); await prepare(job);
  const before = await releases.snapshot(job.id);
  before.routeAliases = { '/photography/old-album': '/photography/test-album' };
  // Existing public asset order need not match the current traversal order of content references.
  before.assets.reverse();
  await bucket.put(`private-snapshots/${job.id}.json`, JSON.stringify(before));
  await bucket.put('active-release.json', JSON.stringify({ releaseId: job.id, schemaVersion: 1, manifestSha256: 'd'.repeat(64), activatedAt: new Date(instant).toISOString(), codeSha, runId }));
  return { before, recordId };
}

describe('bounded public media metadata refresh during rebuild', () => {
  it('refreshes 250 published projections in 100/100/50 batches without reading drafts or changing public content/order', async () => {
    const { before, recordId } = await publishedCandidate(250);
    await memory.transaction(async tx => {
      const records = await Promise.all(before.assets.map(asset => tx.get<MediaAsset>(`media/${asset.id}`)));
      records.forEach(asset => tx.put(`media/${asset!.id}`, { ...asset, metadata: { kind: 'image', detectedMime: 'image/png', bytes: 100, sha256: 'b'.repeat(64), width: 1, height: 1, photography: { cameraModel: `Camera ${asset!.id}`, takenDate: '2024-02-29' } } }));
      tx.put(`albums/${recordId}`, { draft: { title: 'PRIVATE INCOMPLETE LATER EDIT' } });
    });
    operations = 0; batches = []; readKeys = [];
    const job = await releases.create({ changes: [], expectedReleaseId: before.releaseId, rebuildPublished: true }, 'test-admin');
    expect(job).toMatchObject({ rebuildPublished: true, snapshotPrepared: false, preparedAssetCount: 100, assetCount: 250, selectedRevisionIds: {} });
    expect(batches).toEqual([100]); expect(operations).toBeLessThanOrEqual(14);
    expect(await bucket.get(`private-snapshots/${job.id}.json`)).toBeNull();
    await releases.claim(job.id, runId, codeSha);
    operations = 0; batches = [];
    const middle = await releases.prepareSnapshot(job.id, runId);
    expect(middle).toMatchObject({ snapshotPrepared: false, preparedAssetCount: 200 });
    expect(batches).toEqual([100]); expect(operations).toBeLessThanOrEqual(12);
    operations = 0; batches = [];
    const done = await releases.prepareSnapshot(job.id, runId);
    expect(done).toMatchObject({ snapshotPrepared: true, preparedAssetCount: 250 });
    expect(batches).toEqual([50]); expect(operations).toBeLessThanOrEqual(12);
    const actual = await releases.snapshot(job.id);
    expect(actual).toEqual({ ...before, releaseId: job.id, assets: before.assets.map(asset => ({ ...asset, photography: { cameraModel: `Camera ${asset.id}`, takenDate: '2024-02-29' } })) });
    expect(readKeys.filter(key => /^(?:albums|creations|fitness|playlists|settings)\//u.test(key))).toEqual([]);
    expect(await releases.snapshot(before.releaseId)).toEqual(before);
    expect(done.snapshotSha256).toBe(await sha256(JSON.stringify(actual)));
    let manifest = await releases.registerManifest(job.id, runId, files());
    while ('pending' in manifest) manifest = await releases.registerManifest(job.id, runId, files());
    expect(Object.keys(manifest.assets)).toHaveLength(250);
  });

  it.each(['missing', 'processing', 'failed', 'changed-variants'] as const)('keeps the active snapshot intact when a %s media record prevents a later rebuild batch', async state => {
    const { before } = await publishedCandidate(101);
    const lastId = before.assets.at(-1)!.id;
    const rebuild = await releases.create({ changes: [], expectedReleaseId: before.releaseId, rebuildPublished: true }, 'test-admin');
    await releases.claim(rebuild.id, runId, codeSha);
    await memory.transaction(async tx => {
      const asset = await tx.get<MediaAsset>(`media/${lastId}`);
      if (state === 'missing') tx.delete(`media/${lastId}`);
      else tx.put(`media/${lastId}`, state === 'changed-variants' ? { ...asset, variants: asset!.variants.map(variant => ({ ...variant, bytes: variant.bytes + 1 })) } : { ...asset, status: state });
    });
    await expect(releases.prepareSnapshot(rebuild.id, runId)).rejects.toMatchObject({ code: state === 'changed-variants' ? 'MEDIA_CHANGED' : 'MEDIA_NOT_READY' });
    expect((await releases.get(rebuild.id)).preparedAssetCount).toBe(100);
    expect(await bucket.get(`private-snapshots/${rebuild.id}.json`)).toBeNull();
    expect((await releases.active())!.value.releaseId).toBe(before.releaseId);
    expect(await releases.snapshot(before.releaseId)).toEqual(before);
    await expect(releases.registerManifest(rebuild.id, runId, files())).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_PREPARED' });
  });

  it('rejects unavailable or replaced media in the first rebuild batch before creating a candidate', async () => {
    const { before } = await publishedCandidate(1), assetId = before.assets[0]!.id;
    const original = await memory.get<MediaAsset>(`media/${assetId}`);
    for (const state of ['processing', 'changed-variants'] as const) {
      await memory.transaction(async tx => tx.put(`media/${assetId}`, state === 'processing' ? { ...original, status: 'processing' } : { ...original, variants: original!.variants.map(variant => ({ ...variant, width: 2 })) }));
      await expect(releases.create({ changes: [], expectedReleaseId: before.releaseId, rebuildPublished: true }, 'test-admin')).rejects.toMatchObject({ code: state === 'processing' ? 'MEDIA_NOT_READY' : 'MEDIA_CHANGED' });
    }
    expect((await memory.list('releases')).items).toHaveLength(1);
    expect((await releases.active())!.value.releaseId).toBe(before.releaseId);
  });
});

describe('cross-request asset preparation using real local R2 conditional writes', () => {
  it('freezes 50 selected changes across all modules with bounded bulk reads, including idempotent creation and dispatch bookkeeping', async () => {
    const records = new Records(memory, () => instant), changes: ReleaseJob['changes'] = [];
    for (let index = 0; index < 12; index++) {
      const creation = await records.save('creations', CreationDraftSchema, { title: `Test creation ${index}`, slug: `test-${index}`, blocks: [{ id: 'quote', type: 'quote', text: 'Local synthetic test content' }] }, 'test-admin');
      const album = await records.save('albums', AlbumDraftSchema, { title: `Test album ${index}`, slug: `test-${index}`, photos: [] }, 'test-admin');
      const fitness = await records.save('fitness', FitnessEntryDraftSchema, { title: `Test fitness ${index}`, entryDate: '2026-09-12' }, 'test-admin');
      const playlist = await records.save('playlists', PlaylistDraftSchema, { name: `Test playlist ${index}`, source: 'local' }, 'test-admin');
      changes.push({ collection: 'creations', id: creation.id, version: 1, action: 'publish' }, { collection: 'albums', id: album.id, version: 1, action: 'publish' }, { collection: 'fitness', id: fitness.id, version: 1, action: 'publish' }, { collection: 'playlists', id: playlist.id, version: 1, action: 'publish' });
    }
    await records.save('settings', SiteSettingsSchema, { intro: 'Local test settings' }, 'test-admin', 'site');
    await records.save('settings', FitnessSettingsDraftSchema, { startDate: null }, 'test-admin', 'fitness');
    changes.push({ collection: 'settings', id: 'site', version: 1, action: 'publish' }, { collection: 'settings', id: 'fitness', version: 1, action: 'publish' });
    operations = 0; batches = [];
    const key = crypto.randomUUID(), input = { changes, expectedReleaseId: null };
    const job = await releases.create(input, 'test-admin', key);
    expect(job.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    await releases.noteDispatch(job.id, true);
    // Includes R2 + Firestore begin/read/commit protocol costs. The production
    // auth/provider path and one GitHub dispatch add their own bounded requests.
    // Two lifecycle-fence reads prevent a frozen candidate from racing purge.
    expect(operations).toBeLessThanOrEqual(18); expect(batches.filter(value => value > 0)).toEqual([50]);
    const snapshot = await releases.snapshot(job.id);
    expect(snapshot.creations).toHaveLength(12); expect(snapshot.albums).toHaveLength(12); expect(snapshot.fitness.entries).toHaveLength(12); expect(snapshot.playlists).toHaveLength(12);
    expect(snapshot.settings.intro).toBe('Local test settings'); expect(snapshot.fitness.settings.startDate).toBeNull();
    operations = 0; batches = [];
    expect((await releases.create({ ...input, changes: [...changes].reverse() }, 'test-admin', key)).id).toBe(job.id);
    expect(operations).toBe(5); expect(batches).toEqual([]);
    const concurrentKey = crypto.randomUUID();
    const [first, second] = await Promise.all([releases.create(input, 'test-admin', concurrentKey), releases.create(input, 'test-admin', concurrentKey)]);
    expect(first.id).toBe(second.id); expect(first.id).not.toBe(job.id);
    await releases.claim(first.id, 'same-candidate-runner', codeSha);
    expect(await releases.create(input, 'test-admin', concurrentKey)).toMatchObject({ id: first.id, status: 'building', runId: 'same-candidate-runner' });
  });

  it('prepares 250 assets across requests, keeps selected content frozen, and only then exposes the final snapshot', async () => {
    const { job, recordId } = await candidate();
    expect(job).toMatchObject({ snapshotPrepared: false, preparedAssetCount: 100, assetCount: 250 });
    await expect(releases.snapshot(job.id)).rejects.toMatchObject({ code: 'RELEASE_NOT_FOUND' });
    await memory.transaction(async tx => { const record = await tx.get<Record<string, unknown>>(`albums/${recordId}`); tx.put(`albums/${recordId}`, { ...record, draft: { title: 'Later unsaved candidate mutation' } }); });
    const final = await prepare(job), snapshot = await releases.snapshot(job.id);
    expect(snapshot.albums[0]!.title).toBe('Frozen original album'); expect(snapshot.assets).toHaveLength(250);
    expect(final).toMatchObject({ preparedAssetCount: 250, assetCount: 250 });
    expect(final.snapshotSha256).toBe(await sha256(JSON.stringify(snapshot)));
    const frozen = await bucket.get(`private-snapshots/${job.id}.json`);
    expect((await releases.prepareSnapshot(job.id, runId)).snapshotSha256).toBe(final.snapshotSha256);
    expect((await bucket.get(`private-snapshots/${job.id}.json`))!.etag).toBe(frozen!.etag);
  });

  it('does not advance progress or expose a snapshot when a later batch contains unready media', async () => {
    const { job } = await candidate(101);
    await memory.transaction(async tx => { const asset = await tx.get<MediaAsset>('media/asset-00100'); tx.put('media/asset-00100', { ...asset, status: 'processing' }); });
    await expect(releases.prepareSnapshot(job.id, runId)).rejects.toMatchObject({ code: 'MEDIA_NOT_READY' });
    expect(await bucket.get(`private-snapshots/${job.id}.json`)).toBeNull();
    expect((await releases.get(job.id)).preparedAssetCount).toBe(100);
    await expect(releases.registerManifest(job.id, runId, files())).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_PREPARED' });
  });

  it('recovers an R2 progress write whose response was lost, without losing or duplicating a batch', async () => {
    const { job } = await candidate(); losePreparationResponse = true;
    await expect(releases.prepareSnapshot(job.id, runId)).rejects.toThrow('response lost');
    const final = await prepare(job);
    expect(final.preparedAssetCount).toBe(250);
    const snapshot = await releases.snapshot(job.id); expect(new Set(snapshot.assets.map(asset => asset.id)).size).toBe(250);
  });

  it('serializes concurrent preparation by R2 CAS and produces the same immutable snapshot', async () => {
    const { job } = await candidate();
    const parallel = await Promise.all([releases.prepareSnapshot(job.id, runId), releases.prepareSnapshot(job.id, runId)]);
    expect(parallel.every(result => result.preparedAssetCount! >= 200 && result.preparedAssetCount! <= 250)).toBe(true);
    await prepare(await releases.get(job.id));
    const snapshot = await releases.snapshot(job.id);
    expect(snapshot.assets).toHaveLength(250); expect(new Set(snapshot.assets.map(asset => asset.id)).size).toBe(250);
  });

  it('registers a manifest in 100/100/50 steps, freezes the input, and replays the completed result without rereading assets', async () => {
    const { job } = await candidate(); await prepare(job);
    const input = files();
    operations = 0; batches = [];
    expect(await releases.registerManifest(job.id, runId, input)).toEqual({ pending: true, phase: 'assets', processed: 100, total: 250 });
    expect(operations).toBeLessThanOrEqual(12); expect(batches).toEqual([100]);
    expect(await bucket.get(`releases/${job.id}/pending-manifest.json`)).toBeNull();
    const changed = structuredClone(input); changed.files[0]!.bytes++;
    await expect(releases.registerManifest(job.id, runId, changed)).rejects.toMatchObject({ code: 'MANIFEST_CONFLICT' });
    expect(await releases.registerManifest(job.id, runId, input)).toEqual({ pending: true, phase: 'assets', processed: 200, total: 250 });
    operations = 0; batches = [];
    const final = await releases.registerManifest(job.id, runId, input);
    expect('pending' in final).toBe(false); expect(Object.keys((final as ReleaseManifest).assets)).toHaveLength(250);
    expect(operations).toBeLessThanOrEqual(12); expect(batches).toEqual([50]);
    operations = 0; batches = [];
    expect(await releases.registerManifest(job.id, runId, input)).toEqual(final); expect(batches).toEqual([]); expect(operations).toBe(2);
    await expect(releases.registerManifest(job.id, runId, changed)).rejects.toMatchObject({ code: 'MANIFEST_CONFLICT' });
  });

  it('rejects a media projection change after the SSG snapshot was frozen', async () => {
    const { job } = await candidate(1);
    await memory.transaction(async tx => { const asset = await tx.get<MediaAsset>('media/asset-00000'); tx.put('media/asset-00000', { ...asset, variants: asset!.variants.map(value => ({ ...value, bytes: value.bytes + 1 })) }); });
    await expect(releases.registerManifest(job.id, runId, files())).rejects.toMatchObject({ code: 'MEDIA_CHANGED' });
    expect(await bucket.get(`releases/${job.id}/pending-manifest.json`)).toBeNull();
  });

  it('handles concurrent manifest continuation without duplicating assets or changing completed bytes', async () => {
    const { job } = await candidate(); await prepare(job);
    const input = files();
    await Promise.all([releases.registerManifest(job.id, runId, input), releases.registerManifest(job.id, runId, input)]);
    let result = await releases.registerManifest(job.id, runId, input);
    while ('pending' in result) result = await releases.registerManifest(job.id, runId, input);
    expect(Object.keys(result.assets)).toHaveLength(250);
    const before = (await bucket.get(`releases/${job.id}/pending-manifest.json`))!.etag;
    expect(await releases.registerManifest(job.id, runId, input)).toEqual(result);
    expect((await bucket.get(`releases/${job.id}/pending-manifest.json`))!.etag).toBe(before);
  });
});
