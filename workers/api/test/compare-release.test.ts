import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { CreationDraftSchema } from '@xvyin/contracts';
import { Releases, collectAssetIds } from '../src/releases';
import { referencedMedia } from '../src/media-lifecycle';
import { Records } from '../src/records';
import { MemoryStore } from '../src/store/memory';
import type { MediaAsset } from '../src/media';
import { PublicSnapshotSchema } from '../../../apps/web/lib/build-snapshot';
import { searchRecords } from '../../../scripts/v3/search-index';

const now = Date.UTC(2026, 8, 30), codeSha = 'a'.repeat(40), runId = 'comparison-run';
let mf: Miniflare, bucket: R2Bucket, store: MemoryStore, records: Records, releases: Releases;
const before = { assetId: 'image-before', alt: '日出前的山坡', label: '日出前' }, after = { assetId: 'image-after', alt: '日出后的山坡', label: '日出后' };
const compare = { id: 'compare-block', type: 'compare', before, after, caption: '同一机位的晨光变化' };
const draft = { title: '山坡晨光', slug: 'morning-comparison', blocks: [compare] };
const media = (id: string): MediaAsset => ({ id, kind: 'image', status: 'ready', originalName: 'PRIVATE_ORIGINAL_NAME.png', originalKey: `originals/${id}/PRIVATE_KEY`, originalBytes: 100, expectedMime: 'image/png', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  metadata: { kind: 'image', detectedMime: 'image/png', bytes: 100, sha256: 'b'.repeat(64), width: 900, height: 600, gps: { latitude: 12.34567, longitude: 45.67891 }, photography: { cameraModel: 'Test camera' } },
  variants: [{ role: 'content', url: `/api/v1/media/${id}/content`, key: `variants/${id}/content`, mime: 'image/webp', bytes: 80, sha256: 'c'.repeat(64), width: 900, height: 600 }] });
beforeAll(async () => { mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("test fixture"); } }', compatibilityDate: '2026-09-11', r2Buckets: ['MEDIA'] }), telemetry: { enabled: false }, cf: false }); bucket = await mf.getR2Bucket('MEDIA') as unknown as R2Bucket; });
afterAll(async () => { await mf.dispose(); });
beforeEach(async () => { const objects = await bucket.list(); if (objects.objects.length) await bucket.delete(objects.objects.map(item => item.key)); store = new MemoryStore(); records = new Records(store, () => now); releases = new Releases(store, bucket, () => now, codeSha); await store.transaction(async tx => { tx.put('media/image-before', media('image-before')); tx.put('media/image-after', media('image-after')); }); });
async function publish(input: unknown = draft) { const record = await records.save('creations', CreationDraftSchema, input, 'admin', 'comparison'); return releases.create({ changes: [{ collection: 'creations', id: record.id, version: record.version, action: 'publish' }], expectedReleaseId: null }, 'admin'); }

describe('comparison publication and public projection', () => {
  it('preserves both references through save and public projection, indexes only descriptions and protects referenced media', async () => {
    const job = await publish(), snapshot = await releases.snapshot(job.id), publicValue = PublicSnapshotSchema.parse(snapshot);
    expect([...collectAssetIds(publicValue)]).toEqual(['image-before', 'image-after']);
    expect([...referencedMedia(draft)]).toEqual(['image-before', 'image-after']);
    expect(snapshot.assets).toHaveLength(2);
    expect(snapshot.creations[0]!.blocks[0]).toMatchObject({ ...compare, mode: 'side-by-side' });
    expect((await store.get<{ draft: unknown }>('creations/comparison'))!.draft).toMatchObject(draft);
    const serialized = JSON.stringify(publicValue);
    for (const privateField of ['PRIVATE_ORIGINAL', 'PRIVATE_KEY', 'originalKey', 'sha256', 'gps', '12.34567', '45.67891']) expect(serialized).not.toContain(privateField);
    const content = searchRecords(snapshot).records.find(record => record.url === '/creations/morning-comparison')!.content;
    for (const text of [before.alt, after.alt, before.label, after.label, compare.caption]) expect(content).toContain(text);
    expect(content).not.toContain('image-before');
    expect(content).not.toContain('Test camera');
    for (const asset of [{ ...snapshot.assets[1]!, kind: 'audio' }, { ...snapshot.assets[1]!, variants: snapshot.assets[1]!.variants.map(variant => ({ ...variant, width: undefined })) }]) {
      expect(PublicSnapshotSchema.safeParse({ ...snapshot, assets: [snapshot.assets[0], asset] }).success).toBe(false);
    }
    expect(PublicSnapshotSchema.safeParse({ ...snapshot, assets: snapshot.assets.slice(0, 1) }).success).toBe(false);
  });
  it.each(['missing', 'processing', 'failed', 'audio', 'dimensionless'] as const)('keeps a %s comparison as a draft without producing a public snapshot', async state => {
    await store.transaction(async tx => { const asset = media('image-after'); if (state === 'missing') tx.delete('media/image-after'); else tx.put('media/image-after', state === 'audio' ? { ...asset, kind: 'audio' } : state === 'dimensionless' ? { ...asset, variants: asset.variants.map(({ width: _width, ...variant }) => variant) } : { ...asset, status: state }); });
    await expect(publish()).rejects.toMatchObject({ code: ['audio', 'dimensionless'].includes(state) ? 'PUBLISH_VALIDATION' : 'MEDIA_NOT_READY' });
    expect((await store.get<{ draft: unknown }>('creations/comparison'))!.draft).toMatchObject(draft);
    expect((await bucket.list({ prefix: 'private-snapshots/' })).objects).toHaveLength(0);
  });
  it('saves an empty pair and refuses publication until the two descriptions and assets are complete', async () => {
    await expect(publish({ ...draft, blocks: [{ id: 'compare-block', type: 'compare' }] })).rejects.toMatchObject({ code: 'PUBLISH_VALIDATION' });
    expect((await store.get<{ draft: unknown }>('creations/comparison'))!.draft).toMatchObject({ blocks: [{ before: { assetId: '' }, after: { assetId: '' } }] });
  });
  it('checks comparison types in later bounded batches before marking a snapshot ready', async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({ assetId: `gallery-${index}`, alt: `Test image ${index}`, sortOrder: index }));
    await store.transaction(async tx => { for (const item of items) tx.put(`media/${item.assetId}`, media(item.assetId)); tx.put('media/image-after', { ...media('image-after'), kind: 'audio' }); });
    const job = await publish({ ...draft, blocks: [{ id: 'preceding-gallery', type: 'gallery', items }, { ...compare, before: { ...before, assetId: items[0]!.assetId } }] });
    expect(job.snapshotPrepared).toBe(false);
    await releases.claim(job.id, runId, codeSha);
    await expect(releases.prepareSnapshot(job.id, runId)).rejects.toMatchObject({ code: 'PUBLISH_VALIDATION' });
    expect(await bucket.get(`private-snapshots/${job.id}.json`)).toBeNull();
  });
  it('allows only an enabled, nonempty and explicitly dated now section through the public boundary', async () => {
    const snapshot = await releases.snapshot((await publish()).id);
    const current = { enabled: true, text: '最近在整理摄影作品。', updatedAt: new Date(now).toISOString() };
    expect(PublicSnapshotSchema.safeParse({ ...snapshot, settings: { ...snapshot.settings, now: current } }).success).toBe(true);
    for (const invalid of [{ ...current, enabled: false }, { ...current, text: '' }, { ...current, text: '   ' }, { ...current, updatedAt: null }]) {
      expect(PublicSnapshotSchema.safeParse({ ...snapshot, settings: { ...snapshot.settings, now: invalid } }).success).toBe(false);
    }
  });
});
