import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { CreationDraftSchema, MEDIA_LIMITS, SiteSettingsSchema } from '@xvyin/contracts';
import { MediaLibrary, type PurgeJob } from '../src/media-library';
import { MemoryStore } from '../src/store/memory';
import { Records } from '../src/records';
import { Releases } from '../src/releases';
import type { MediaAsset, Quota } from '../src/media';
import { MEDIA_FENCE_KEY, validateDraftMedia } from '../src/media-lifecycle';
import type { Store } from '../src/store/types';

let mf: Miniflare, bucket: R2Bucket, store: MemoryStore, library: MediaLibrary, now: number;
const uid = 'local-admin', instant = Date.UTC(2026, 8, 13, 5), hash = 'a'.repeat(64);
function asset(id = 'local-image', extra: Partial<MediaAsset> = {}): MediaAsset {
  return { id, kind: 'image', originalName: `${id}.jpg`, originalKey: `originals/${id}/source`, originalBytes: 10, expectedMime: 'image/jpeg', status: 'ready', variants: [{ role: 'content', key: `variants/${id}/run/content`, sha256: hash, bytes: 5, mime: 'image/webp', url: `/api/v1/media/${id}/content` }], createdAt: new Date(instant).toISOString(), updatedAt: new Date(instant).toISOString(), ...extra };
}
beforeAll(async () => {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("local test"); } }', compatibilityDate: '2026-09-11', r2Buckets: ['MEDIA'] }), telemetry: { enabled: false }, cf: false }); bucket = await mf.getR2Bucket('MEDIA') as unknown as R2Bucket;
});
afterAll(async () => { await mf.dispose(); });
beforeEach(async () => {
  let cursor: string | undefined;
  do { const page = await bucket.list({ cursor }); if (page.objects.length) await bucket.delete(page.objects.map(item => item.key)); cursor = page.truncated ? page.cursor : undefined; } while (cursor);
  store = new MemoryStore(); now = instant; library = new MediaLibrary(store, bucket, () => now);
});
async function seed(value = asset()): Promise<void> {
  await bucket.put(value.originalKey, '0123456789'); for (const variant of value.variants) await bucket.put(variant.key, '01234');
  await store.transaction(async tx => { tx.put(`media/${value.id}`, value); tx.put('system/media_quota', { usedBytes: value.originalBytes + value.variants.reduce((sum, variant) => sum + variant.bytes, 0), reservedBytes: 0, limitBytes: MEDIA_LIMITS.totalBytes }); });
}
async function begin(id = 'local-image'): Promise<PurgeJob> { await library.trash(id, { expectedVersion: 1 }, uid); return library.startPurge(id, { expectedVersion: 2 }, uid, crypto.randomUUID()); }
async function check(job: PurgeJob): Promise<PurgeJob> { for (let index = 0; index < 50 && job.status === 'checking'; index++) job = await library.advancePurge(job.id, uid); return job; }

describe('private media catalog and reversible management', () => {
  it('backfills five legacy records at a time and never claims an incomplete catalog is empty', async () => {
    store = new MemoryStore(Object.fromEntries(Array.from({ length: 12 }, (_, index) => { const row = asset(`old-${String(index).padStart(2, '0')}`); return [`media/${row.id}`, row]; }))); library = new MediaLibrary(store, bucket, () => now);
    expect(await library.list()).toMatchObject({ catalogReady: false, items: [] });
    expect(await library.advanceCatalog()).toMatchObject({ ready: false, processed: 5 });
    expect(await library.advanceCatalog()).toMatchObject({ ready: false, processed: 10 });
    expect(await library.advanceCatalog()).toMatchObject({ ready: true, processed: 12 });
    expect((await library.list({ sort: 'name', direction: 'asc' })).items.map(row => row.id)).toEqual(Array.from({ length: 12 }, (_, index) => `old-${String(index).padStart(2, '0')}`));
  });
  it('scans globally sorted pages and returns a continuation for an empty filtered page', async () => {
    await library.advanceCatalog();
    await store.transaction(async tx => { for (let index = 0; index < 70; index++) tx.put(`media/item-${index}`, asset(`item-${index}`, { originalName: `${String(index).padStart(3, '0')}.jpg`, category: index >= 60 ? '健身' : '摄影' })); });
    const first = await library.list({ category: '健身', sort: 'name', direction: 'asc' }); expect(first.items).toEqual([]); expect(first.scanned).toBe(48); expect(first.nextCursor).toBeTruthy();
    const second = await library.list({ category: '健身', sort: 'name', direction: 'asc', cursor: first.nextCursor! }); expect(second.items).toHaveLength(10); expect(second.nextCursor).toBeNull();
    await expect(library.list({ category: '摄影', sort: 'name', direction: 'asc', cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
  it('updates category with optimistic versions, restores without changing bytes, and validates hash matches against the current asset', async () => {
    const value = asset('dedup', { metadata: { kind: 'image', detectedMime: 'image/jpeg', bytes: 10, sha256: hash, width: 1, height: 1 } }); await seed(value); await library.advanceCatalog();
    const updated = await library.update(value.id, { expectedVersion: 1, category: '健身影像' }); expect(updated.version).toBe(2);
    expect(await library.findDuplicate({ sha256: hash, kind: 'image', bytes: 10 })).toMatchObject({ id: value.id });
    await library.trash(value.id, { expectedVersion: 2 }, uid); expect(await library.findDuplicate({ sha256: hash, kind: 'image', bytes: 10 })).toBeNull();
    expect((await library.list({ lifecycle: 'trash' })).items).toHaveLength(1);
    await library.restore(value.id, { expectedVersion: 3 }, uid); expect(await library.findDuplicate({ sha256: hash, kind: 'image', bytes: 10 })).toMatchObject({ id: value.id });
    await expect(library.update(value.id, { expectedVersion: 2, category: '' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await store.get<Quota>('system/media_quota')).toMatchObject({ usedBytes: 15, reservedBytes: 0 }); expect(await bucket.head(value.originalKey)).not.toBeNull();
  });
});

describe('resumable deletion with references, writer fencing and exactly-once accounting', () => {
  it.each(['draft', 'settings', 'revision', 'release', 'active_release'] as const)('blocks an otherwise unused media item retained by %s', async kind => {
    await seed();
    await store.transaction(async tx => {
      if (kind === 'draft') tx.put('fitness/draft', { draft: { title: 'Private photo', photos: [{ assetId: 'local-image', status: 'hidden' }] } });
      if (kind === 'settings') tx.put('settings/site', { draft: { avatarAssetId: 'local-image' } });
      if (kind === 'revision') tx.put('revisions/old', { collection: 'creations', data: { blocks: [{ assetId: 'local-image' }] } });
      if (kind === 'release') tx.put('releases/history', { id: 'history', status: 'superseded' });
    });
    if (kind === 'release' || kind === 'active_release') await bucket.put('private-snapshots/history.json', JSON.stringify({ assets: [{ id: 'local-image' }] }));
    if (kind === 'active_release') await bucket.put('active-release.json', JSON.stringify({ releaseId: 'history' }));
    const job = await check(await begin()); expect(job.status).toBe('blocked'); expect(job.references[0]?.kind).toBe(kind === 'active_release' ? 'release' : kind);
    expect(await store.get('media/local-image')).not.toHaveProperty('purgeJobId');
    expect(await bucket.head('originals/local-image/source')).not.toBeNull(); expect(await store.get<Quota>('system/media_quota')).toMatchObject({ usedBytes: 15 });
    const records = new Records(store, () => now); await expect(records.save('creations', CreationDraftSchema, { title: 'Editing resumes after blocked check' }, uid)).resolves.toBeTruthy();
  });
  it('requires separate confirmation, does one object per step, resumes ambiguous R2 deletes and settles quota only once', async () => {
    await seed(); await library.advanceCatalog(); const job = await check(await begin()); expect(job.status).toBe('ready'); expect(await bucket.head('originals/local-image/source')).not.toBeNull();
    await expect(new Records(store, () => now).save('creations', CreationDraftSchema, {}, uid)).rejects.toMatchObject({ code: 'MEDIA_CLEANUP_BUSY' });
    await library.confirmPurge(job.id, uid);
    expect((await library.list({ lifecycle: 'trash' })).items[0]).toMatchObject({ lifecycle: 'purging', purgeJobId: job.id });
    await expect(new Records(store, () => now).save('creations', CreationDraftSchema, { title: 'Other editing continues during cleanup' }, uid)).resolves.toBeTruthy();
    const transport = new Proxy(bucket, { get(target, property) { if (property === 'delete') return async (key: string) => { await target.delete(key); throw new Error('Local test: delete acknowledgement lost'); }; const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; } });
    await expect(new MediaLibrary(store, transport, () => now).advancePurge(job.id, uid)).rejects.toThrow('acknowledgement lost');
    expect(await store.get<Quota>('system/media_quota')).toMatchObject({ usedBytes: 15 });
    expect(await library.advancePurge(job.id, uid)).toMatchObject({ status: 'deleting', completedKeys: 1 });
    const completed = await library.advancePurge(job.id, uid); expect(completed).toMatchObject({ status: 'deleted', completedKeys: 2 });
    expect(await library.advancePurge(job.id, uid)).toEqual(completed); expect(await library.confirmPurge(job.id, uid)).toEqual(completed);
    expect(await store.get<Quota>('system/media_quota')).toMatchObject({ usedBytes: 0, reservedBytes: 0 }); expect(await store.get<MediaAsset>('media/local-image')).toMatchObject({ lifecycle: 'deleted' });
    expect((await library.list({ lifecycle: 'trash' })).items).toEqual([]); expect(await store.get('media_catalog/local-image')).toBeNull();
    await expect(new Records(store, () => now).save('creations', CreationDraftSchema, { blocks: [{ id: 'old', type: 'image', assetId: 'local-image' }] }, uid)).rejects.toMatchObject({ code: 'MEDIA_DELETED' });
    await expect(library.restore('local-image', { expectedVersion: 4 }, uid)).rejects.toMatchObject({ code: 'MEDIA_CLEANUP_BUSY' });
  });
  it('expires a ready check, supports cancellation, and does not reuse old proof after writers resume', async () => {
    await seed(); const job = await check(await begin()); now += 16 * 60_000;
    expect(await library.getPurge(job.id, uid)).toMatchObject({ status: 'expired' });
    await expect(library.confirmPurge(job.id, uid)).rejects.toMatchObject({ code: 'PURGE_NOT_READY' });
    await expect(new Records(store, () => now).save('settings', SiteSettingsSchema, {}, uid, 'site')).resolves.toBeTruthy();
    expect(await library.cancelPurge(job.id, uid)).toMatchObject({ status: 'cancelled' });
    expect(await store.get('media/local-image')).not.toHaveProperty('purgeJobId');
    await expect(library.confirmPurge(job.id, uid)).rejects.toMatchObject({ code: 'PURGE_NOT_READY' });
  });
  it('starts fresh after expiry and cannot clear a replacement check by cancelling the old job', async () => {
    await seed(); const old = await check(await begin()); now += 16 * 60_000;
    const replacement = await library.startPurge('local-image', { expectedVersion: 2 }, uid, crypto.randomUUID());
    expect(replacement.id).not.toBe(old.id); expect(replacement).toMatchObject({ status: 'checking', phase: 0, processed: 0 });
    await library.cancelPurge(old.id, uid);
    expect(await store.get('media/local-image')).toMatchObject({ purgeJobId: replacement.id });
    expect(await store.get(MEDIA_FENCE_KEY)).toMatchObject({ taskId: replacement.id });
    await library.cancelPurge(replacement.id, uid);
    expect(await store.get('media/local-image')).not.toHaveProperty('purgeJobId');
  });
  it('rejects active processing and failed jobs with retained reservations', async () => {
    await seed(asset('busy', { status: 'processing' })); await expect(library.trash('busy', { expectedVersion: 1 }, uid)).rejects.toMatchObject({ code: 'MEDIA_BUSY' });
    await seed(asset('failed', { status: 'failed' })); await library.trash('failed', { expectedVersion: 1 }, uid);
    await store.transaction(async tx => { tx.put('processing/failed', { state: 'failed', reservedBytes: 100, variants: [] }); });
    await expect(library.startPurge('failed', { expectedVersion: 2 }, uid, crypto.randomUUID())).rejects.toMatchObject({ code: 'MEDIA_CLEANUP_REQUIRED' });
  });
  it('uses an idempotent check receipt and rejects a different version for that request', async () => {
    await seed(); await library.trash('local-image', { expectedVersion: 1 }, uid); const key = crypto.randomUUID();
    const first = await library.startPurge('local-image', { expectedVersion: 2 }, uid, key); expect(await library.startPurge('local-image', { expectedVersion: 2 }, uid, key)).toEqual(first);
    await expect(library.startPurge('local-image', { expectedVersion: 3 }, uid, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('detects deletion beginning between reference preflight and the save transaction', async () => {
    await seed(); let fenced = false;
    const wrapped: Store = { get: store.get.bind(store), list: store.list.bind(store), transaction: store.transaction.bind(store), getMany: async <T>(keys: readonly string[]) => {
      const result = await store.getMany<T>(keys); if (!fenced) { fenced = true; await begin(); } return result;
    } };
    await expect(new Records(wrapped, () => now).save('creations', CreationDraftSchema, { blocks: [{ id: 'photo', type: 'image', assetId: 'local-image' }] }, uid)).rejects.toMatchObject({ code: 'MEDIA_CLEANUP_BUSY' });
    expect((await store.list('creations')).items).toEqual([]);
  });
  it('rejects an old media preflight even after purge finishes and the global fence is released', async () => {
    await seed(); let purged = false;
    const wrapped: Store = { get: store.get.bind(store), list: store.list.bind(store), transaction: store.transaction.bind(store), getMany: async <T>(keys: readonly string[]) => {
      const result = await store.getMany<T>(keys);
      if (!purged) { purged = true; const job = await check(await begin()); await library.confirmPurge(job.id, uid); await library.advancePurge(job.id, uid); await library.advancePurge(job.id, uid); }
      return result;
    } };
    await expect(new Records(wrapped, () => now).save('creations', CreationDraftSchema, { blocks: [{ id: 'photo', type: 'image', assetId: 'local-image' }] }, uid)).rejects.toMatchObject({ code: 'MEDIA_STATE_CHANGED' });
    expect((await store.list('creations')).items).toEqual([]);
  });
  it('detects deletion beginning between release freezing and candidate registration', async () => {
    const records = new Records(store, () => now); const record = await records.save('creations', CreationDraftSchema, { title: 'Other article', slug: 'other-article', blocks: [{ id: 'quote', type: 'quote', text: 'Local fixture' }] }, uid); await seed();
    let fenced = false;
    const transport = new Proxy(bucket, { get(target, property) { if (property === 'put') return async (key: string, ...args: unknown[]) => {
      const result = await Reflect.apply(target.put, target, [key, ...args]); if (key.startsWith('private-snapshots/') && !fenced) { fenced = true; await begin(); } return result;
    }; const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; } });
    await expect(new Releases(store, transport, () => now, 'a'.repeat(40)).create({ changes: [{ collection: 'creations', id: record.id, version: 1, action: 'publish' }], expectedReleaseId: null }, uid)).rejects.toMatchObject({ code: 'MEDIA_CLEANUP_BUSY' });
    expect((await store.list('releases')).items).toHaveLength(0);
  });
  it('keeps a bounded 100-key reference batch and allows empty unfinished references', async () => {
    const getMany = vi.spyOn(store, 'getMany'); await validateDraftMedia(store, { photos: Array.from({ length: 201 }, (_, index) => ({ assetId: `placeholder-${index}` })), coverAssetId: '' }, now);
    expect(getMany.mock.calls.map(call => call[0].length)).toEqual([100, 100, 1]);
    await expect(validateDraftMedia(store, { photos: Array.from({ length: 2001 }, (_, index) => ({ assetId: `placeholder-${index}` })) }, now)).rejects.toMatchObject({ code: 'MEDIA_REFERENCE_LIMIT' });
    expect(await store.get(MEDIA_FENCE_KEY)).toBeNull();
  });
});
