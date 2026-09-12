import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MEDIA_LIMITS } from '@xvyin/contracts';
import { Processing, type ProcessingJob, type ProcessingVariant } from '../src/processing';
import { PART_SIZE, type MediaAsset, type Quota } from '../src/media';
import { sha256 } from '../src/security';
import { MemoryStore } from '../src/store/memory';

// Explicit boundary fixtures. Decoder tests use real files in process-media.test.ts.
const instant = Date.UTC(2026, 8, 12, 5), run = 'qa-processing-run';
let mf: Miniflare, bucket: R2Bucket, store: MemoryStore, processing: Processing;
beforeAll(async () => {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("test")}}', compatibilityDate: '2026-09-11', r2Buckets: ['MEDIA'] }), telemetry: { enabled: false }, cf: false });
  bucket = await mf.getR2Bucket('MEDIA') as unknown as R2Bucket;
});
beforeEach(async () => {
  let cursor: string | undefined;
  do { const page = await bucket.list({ cursor }); if (page.objects.length) await bucket.delete(page.objects.map(item => item.key)); cursor = page.truncated ? page.cursor : undefined; } while (cursor);
  store = new MemoryStore(); processing = new Processing(store, bucket, () => instant);
});
afterAll(async () => { await mf?.dispose(); });
async function seed(id = 'test-image', kind: 'image' | 'video' | 'file' = 'image') {
  const source = new TextEncoder().encode('private test source'), hash = await sha256(source), originalKey = `originals/${id}/source`;
  await bucket.put(originalKey, source);
  const asset: MediaAsset = { id, kind, originalName: 'test source', originalKey, originalBytes: source.length, expectedMime: kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'text/plain', expectedSha256: hash, status: 'processing', variants: [], createdAt: new Date(instant).toISOString(), updatedAt: new Date(instant).toISOString() };
  await store.transaction(async tx => { const quota = await tx.get<Quota>('system/media_quota') || { usedBytes: 0, reservedBytes: 0, limitBytes: MEDIA_LIMITS.totalBytes }; tx.put(`media/${id}`, asset); tx.put('system/media_quota', { ...quota, usedBytes: quota.usedBytes + source.length }); });
  return { asset, source, metadata: { kind, detectedMime: asset.expectedMime, bytes: source.length, sha256: hash, ...(kind === 'image' ? { width: 640, height: 480 } : kind === 'video' ? { width: 640, height: 360, durationMs: 1000 } : {}) } };
}
function partRequest(bytes: Uint8Array, length = bytes.length) { return new Request('https://private.test/part', { method: 'PUT', headers: { 'content-length': String(length) }, body: new Uint8Array(bytes) }); }
function multipartEtag(parts: Uint8Array[]) { const hash = createHash('md5'); for (const part of parts) hash.update(createHash('md5').update(part).digest()); return `${hash.digest('hex')}-${parts.length}`; }
async function imagePlan() {
  const bytes = new TextEncoder().encode('test derivative'), hash = await sha256(bytes);
  const variants = ['thumb', 'content', 'large'].map(role => ({ role: role as ProcessingVariant['role'], mime: 'image/webp' as const, bytes: bytes.length, sha256: hash, partSha256: [hash], multipartEtag: multipartEtag([bytes]), width: 10, height: 10 }));
  return { bytes, variants };
}
async function finishImages(id: string) { const plan = await imagePlan(); for (const variant of plan.variants) { await processing.part(id, run, variant.role, 1, partRequest(plan.bytes)); await processing.completeVariant(id, run, variant.role); } return processing.finish(id, run); }

describe('private processing state machine with real R2 multipart', () => {
  it('binds one run, streams private source, and detects original replacement', async () => {
    const { asset, source } = await seed();
    const claim = await processing.claim(asset.id, run); expect(claim.metadata.expectedBytes).toBe(source.length);
    expect(await processing.claim(asset.id, run)).toEqual(claim);
    await expect(processing.claim(asset.id, 'different-run')).rejects.toMatchObject({ code: 'PROCESSING_RUN_MISMATCH' });
    const response = await processing.source(asset.id, run, new Request('https://private.test/source'));
    expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(await response.text()).toBe(new TextDecoder().decode(source));
    await bucket.put(asset.originalKey, 'changed');
    await expect(processing.source(asset.id, run, new Request('https://private.test/source'))).rejects.toMatchObject({ code: 'ORIGINAL_MISMATCH' });
  });
  it('reserves all output bytes once, verifies objects, and finishes exactly once', async () => {
    const { asset, metadata } = await seed(), { variants, bytes } = await imagePlan();
    await processing.claim(asset.id, run);
    const plan = await processing.plan(asset.id, run, { metadata, variants });
    expect(plan.reservedBytes).toBe(bytes.length * 3);
    await processing.plan(asset.id, run, { metadata, variants: [...variants].reverse() });
    expect((await store.get<Quota>('system/media_quota'))!.reservedBytes).toBe(bytes.length * 3);
    await expect(processing.finish(asset.id, run)).rejects.toMatchObject({ code: 'PROCESSING_INCOMPLETE' });
    const ready = await finishImages(asset.id); expect(ready.status).toBe('ready'); expect(ready.originalKey).toBe(asset.originalKey); expect(ready.variants).toHaveLength(3);
    expect(await processing.finish(asset.id, run)).toEqual(ready);
    const quota = (await store.get<Quota>('system/media_quota'))!;
    expect(quota.reservedBytes).toBe(0); expect(quota.usedBytes).toBe(asset.originalBytes + bytes.length * 3);
    expect((await bucket.head(asset.originalKey))!.size).toBe(asset.originalBytes);
  });
  it('rejects mismatched metadata, missing roles, private fields and changed plans', async () => {
    const { asset, metadata } = await seed(), { variants } = await imagePlan(); await processing.claim(asset.id, run);
    await expect(processing.plan(asset.id, run, { metadata: { ...metadata, sha256: '0'.repeat(64) }, variants })).rejects.toMatchObject({ code: 'DETECTED_METADATA_MISMATCH' });
    await expect(processing.plan(asset.id, run, { metadata, variants: variants.slice(1) })).rejects.toMatchObject({ code: 'MISSING_VARIANT' });
    await expect(processing.plan(asset.id, run, { metadata, variants, sourceKey: 'private' })).rejects.toHaveProperty('name', 'ZodError');
    await processing.plan(asset.id, run, { metadata, variants });
    await expect(processing.plan(asset.id, run, { metadata, variants: variants.map(item => ({ ...item, sha256: '0'.repeat(64) })) })).rejects.toMatchObject({ code: 'PLAN_CONFLICT' });
  });
  it('atomically admits only one plan near the total 10 GB quota', async () => {
    const a = await seed('image-a'), b = await seed('image-b'), { variants, bytes } = await imagePlan();
    await processing.claim(a.asset.id, run); await processing.claim(b.asset.id, run);
    await store.transaction(async tx => { const quota = (await tx.get<Quota>('system/media_quota'))!; tx.put('system/media_quota', { ...quota, usedBytes: MEDIA_LIMITS.totalBytes - bytes.length * 3 }); });
    const results = await Promise.allSettled([processing.plan(a.asset.id, run, { metadata: a.metadata, variants }), processing.plan(b.asset.id, run, { metadata: b.metadata, variants })]);
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1); expect((await store.get<Quota>('system/media_quota'))!.reservedBytes).toBe(bytes.length * 3);
  });
  it('measures short/long bodies and prevents replacement of an acknowledged part', async () => {
    const { asset, metadata } = await seed(), { variants, bytes } = await imagePlan(); await processing.claim(asset.id, run); await processing.plan(asset.id, run, { metadata, variants });
    await expect(processing.part(asset.id, run, 'thumb', 0, partRequest(bytes))).rejects.toMatchObject({ code: 'INVALID_PART' });
    await expect(processing.part(asset.id, run, 'thumb', 1, partRequest(bytes.slice(1), bytes.length))).rejects.toMatchObject({ code: 'PART_SIZE_MISMATCH' });
    await expect(processing.part(asset.id, run, 'thumb', 1, partRequest(new Uint8Array(bytes.length + 1), bytes.length))).rejects.toMatchObject({ code: 'PART_SIZE_MISMATCH' });
    const part = await processing.part(asset.id, run, 'thumb', 1, partRequest(bytes));
    expect(await processing.part(asset.id, run, 'thumb', 1, partRequest(bytes))).toEqual(part);
    await expect(processing.part(asset.id, run, 'thumb', 1, partRequest(new Uint8Array(bytes.length)))).rejects.toMatchObject({ code: 'PART_HASH_MISMATCH' });
    expect(Object.keys((await processing.get(asset.id, run)).variants.find(item => item.role === 'thumb')!.leases)).toHaveLength(0);
  });
  it('uses a real 5 MiB first part plus measured final part for video', async () => {
    const { asset, metadata } = await seed('test-video', 'video'), bytes = new Uint8Array(PART_SIZE + 31).fill(42), poster = new Uint8Array([1, 2, 3]);
    await processing.claim(asset.id, run);
    await processing.plan(asset.id, run, { metadata, variants: [{ role: 'playback', mime: 'video/mp4', bytes: bytes.length, sha256: await sha256(bytes), partSha256: [await sha256(bytes.slice(0, PART_SIZE)), await sha256(bytes.slice(PART_SIZE))], multipartEtag: multipartEtag([bytes.slice(0, PART_SIZE), bytes.slice(PART_SIZE)]), width: 640, height: 360, durationMs: 1000 }, { role: 'poster', mime: 'image/webp', bytes: poster.length, sha256: await sha256(poster), partSha256: [await sha256(poster)], multipartEtag: multipartEtag([poster]), width: 640, height: 360 }] });
    await processing.part(asset.id, run, 'playback', 2, partRequest(bytes.slice(PART_SIZE)));
    await expect(processing.completeVariant(asset.id, run, 'playback')).rejects.toMatchObject({ code: 'VARIANT_INCOMPLETE' });
    await processing.part(asset.id, run, 'playback', 1, partRequest(bytes.slice(0, PART_SIZE)));
    expect((await processing.completeVariant(asset.id, run, 'playback')).state).toBe('complete');
    await processing.part(asset.id, run, 'poster', 1, partRequest(poster)); await processing.completeVariant(asset.id, run, 'poster');
    const done = await processing.finish(asset.id, run); expect(done.variants.find(item => item.role === 'playback')!.bytes).toBe(PART_SIZE + 31);
  });
  it('rejects a bad actual part hash before recording any ETag, retaining quota', async () => {
    const { asset, metadata } = await seed(), { variants, bytes } = await imagePlan(); await processing.claim(asset.id, run); await processing.plan(asset.id, run, { metadata, variants });
    await expect(processing.part(asset.id, run, 'thumb', 1, partRequest(new Uint8Array(bytes.length)))).rejects.toMatchObject({ code: 'PART_HASH_MISMATCH' });
    expect((await processing.get(asset.id, run)).variants.find(item => item.role === 'thumb')!.parts).toHaveLength(0);
    await processing.fail(asset.id, run, { code: 'PART_HASH_MISMATCH', message: 'Test mismatch' });
    expect((await store.get<MediaAsset>(`media/${asset.id}`))!.status).toBe('failed');
    expect((await store.get<Quota>('system/media_quota'))!.reservedBytes).toBe(bytes.length * 3);
    expect((await processing.get(asset.id, run)).state).toBe('failed');
  });
  it('reconciles lost multipart-complete acknowledgement and rejects later tampering', async () => {
    const { asset, metadata } = await seed(), { variants, bytes } = await imagePlan(); await processing.claim(asset.id, run); await processing.plan(asset.id, run, { metadata, variants });
    await processing.part(asset.id, run, 'thumb', 1, partRequest(bytes));
    const task = (await processing.get(asset.id, run)).variants.find(item => item.role === 'thumb')!;
    await bucket.resumeMultipartUpload(task.key, task.r2UploadId!).complete(task.parts.map(({ partNumber, etag }) => ({ partNumber, etag })));
    expect((await processing.completeVariant(asset.id, run, 'thumb')).state).toBe('complete');
    for (const role of ['content', 'large']) { await processing.part(asset.id, run, role, 1, partRequest(bytes)); await processing.completeVariant(asset.id, run, role); }
    await bucket.put(task.key, bytes, { customMetadata: { sha256: task.sha256 } });
    await expect(processing.finish(asset.id, run)).rejects.toMatchObject({ code: 'VARIANT_STATE_CONFLICT' });
  });
  it('verifies persisted metadata when the real completion reply omits it', async () => {
    const { asset, metadata } = await seed(), { variants, bytes } = await imagePlan();
    await processing.claim(asset.id, run); await processing.plan(asset.id, run, { metadata, variants });
    let strippedReplies = 0;
    const liveLike = new Proxy(bucket, { get(target, property) {
      if (property === 'resumeMultipartUpload') return (key: string, uploadId: string) => {
        const upload = target.resumeMultipartUpload(key, uploadId);
        return new Proxy(upload, { get(original, field) {
          if (field === 'complete') return async (parts: R2UploadedPart[]) => {
            const object = await original.complete(parts); strippedReplies++;
            return { ...object, customMetadata: undefined };
          };
          const value = Reflect.get(original, field); return typeof value === 'function' ? value.bind(original) : value;
        } });
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const liveProcessing = new Processing(store, liveLike, () => instant);
    for (const variant of variants) {
      await liveProcessing.part(asset.id, run, variant.role, 1, partRequest(bytes));
      expect((await liveProcessing.completeVariant(asset.id, run, variant.role)).state).toBe('complete');
    }
    expect(strippedReplies).toBe(3); expect((await liveProcessing.finish(asset.id, run)).status).toBe('ready');
  });
  it('checks active request leases before accepting another body', async () => {
    const { asset, metadata } = await seed(), { variants, bytes } = await imagePlan(); await processing.claim(asset.id, run); await processing.plan(asset.id, run, { metadata, variants });
    await store.transaction(async tx => { const job = (await tx.get<ProcessingJob>(`processing/${asset.id}`))!; tx.put(`processing/${asset.id}`, { ...job, variants: job.variants.map(task => task.role === 'large' ? task : { ...task, leases: { 1: { token: crypto.randomUUID(), expiresAt: instant + 10000 } } }) }); });
    await expect(processing.part(asset.id, run, 'large', 1, partRequest(bytes))).rejects.toMatchObject({ code: 'PROCESSING_CONCURRENCY_LIMIT' });
    await expect(processing.part(asset.id, run, 'thumb', 1, partRequest(bytes))).rejects.toMatchObject({ code: 'PART_BUSY' });
  });
  it('does not download whole variants during complete or finish on Workers Free', async () => {
    const { asset, metadata } = await seed(), { variants, bytes } = await imagePlan(); await processing.claim(asset.id, run); await processing.plan(asset.id, run, { metadata, variants });
    const guarded = new Proxy(bucket, { get(target, property) { if (property === 'get') return () => { throw new Error('whole object reads forbidden during completion'); }; const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; } });
    const freeProcessing = new Processing(store, guarded, () => instant);
    for (const variant of variants) { await freeProcessing.part(asset.id, run, variant.role, 1, partRequest(bytes)); await freeProcessing.completeVariant(asset.id, run, variant.role); }
    expect((await freeProcessing.finish(asset.id, run)).status).toBe('ready');
  });
  it('rejects a forged stored object before completion despite matching length and manifest SHA', async () => {
    const { asset, metadata } = await seed(), { variants, bytes } = await imagePlan(); await processing.claim(asset.id, run); await processing.plan(asset.id, run, { metadata, variants });
    await processing.part(asset.id, run, 'thumb', 1, partRequest(bytes));
    const task = (await processing.get(asset.id, run)).variants.find(item => item.role === 'thumb')!;
    await bucket.put(task.key, new Uint8Array(bytes.length), { customMetadata: { sha256: task.sha256, assetId: asset.id, runId: run, role: task.role } });
    await expect(processing.completeVariant(asset.id, run, 'thumb')).rejects.toMatchObject({ code: 'VARIANT_ETAG_MISMATCH' });
  });
  it('requires exactly one trusted digest for each planned bounded part', async () => {
    const { asset, metadata } = await seed(), { variants } = await imagePlan(); await processing.claim(asset.id, run);
    await expect(processing.plan(asset.id, run, { metadata, variants: variants.map(variant => ({ ...variant, partSha256: [] })) })).rejects.toHaveProperty('name', 'ZodError');
    await expect(processing.plan(asset.id, run, { metadata, variants: variants.map(variant => ({ ...variant, partSha256: [variant.sha256, variant.sha256] })) })).rejects.toHaveProperty('name', 'ZodError');
    expect((await store.get<Quota>('system/media_quota'))!.reservedBytes).toBe(0);
  });
});
