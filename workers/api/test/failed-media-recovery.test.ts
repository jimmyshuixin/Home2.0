import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MEDIA_LIMITS } from '@xvyin/contracts';
import { Media, type MediaAsset, type Quota } from '../src/media';
import { MediaLibrary, type PurgeJob } from '../src/media-library';
import { Processing, type ProcessingJob } from '../src/processing';
import { MemoryStore } from '../src/store/memory';
import type { Store } from '../src/store/types';
import { sha256 } from '../src/security';

let mf: Miniflare, bucket: R2Bucket, store: MemoryStore, library: MediaLibrary, processing: Processing, now: number;
const uid = 'recovery-admin', assetId = 'failed-file', runId = 'github-12345', instant = Date.UTC(2026, 8, 29), source = new TextEncoder().encode('safe local fixture');
const request = () => new Request('https://fixture.invalid/part', { method: 'PUT', body: source });
beforeAll(async () => {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("local test"); } }', compatibilityDate: '2026-09-11', r2Buckets: ['MEDIA'] }), telemetry: { enabled: false }, cf: false });
  bucket = await mf.getR2Bucket('MEDIA') as unknown as R2Bucket;
});
afterAll(async () => { await mf.dispose(); });
beforeEach(async () => {
  const page = await bucket.list(); if (page.objects.length) await bucket.delete(page.objects.map(item => item.key));
  now = instant; store = new MemoryStore(); library = new MediaLibrary(store, bucket, () => now); processing = new Processing(store, bucket, () => now);
});
async function original() {
  const hash = await sha256(source), originalKey = `originals/${assetId}/source`;
  await bucket.put(originalKey, source);
  const value: MediaAsset = { id: assetId, kind: 'file', originalName: 'fixture.txt', originalKey, originalBytes: source.length, expectedMime: 'text/plain', status: 'processing', variants: [], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
  await store.transaction(async tx => { tx.put(`media/${assetId}`, value); tx.put('system/media_quota', { usedBytes: source.length, reservedBytes: 0, limitBytes: MEDIA_LIMITS.totalBytes }); });
  await processing.claim(assetId, runId);
  return { metadata: { kind: 'file', detectedMime: 'text/plain', bytes: source.length, sha256: hash }, variants: [{ role: 'download', mime: 'text/plain', bytes: source.length, sha256: hash, partSha256: [hash], multipartEtag: `${createHash('md5').update(createHash('md5').update(source).digest()).digest('hex')}-1` }] };
}
async function failed(complete = false) {
  const plan = await original(); await processing.plan(assetId, runId, plan); await processing.part(assetId, runId, 'download', 1, request());
  if (complete) await processing.completeVariant(assetId, runId, 'download');
  await processing.fail(assetId, runId, { code: 'TEST_FAILURE', message: 'Synthetic interrupted runner' });
  return (await store.get<ProcessingJob>(`processing/${assetId}`))!;
}
async function begin() { await library.trash(assetId, { expectedVersion: 1 }, uid); return library.startPurge(assetId, { expectedVersion: 2 }, uid, crypto.randomUUID()); }
async function checked(job: PurgeJob) { for (let step = 0; job.status === 'checking' && step < 30; step++) job = await library.advancePurge(job.id, uid); return job; }
async function deleted(job: PurgeJob) { for (let step = 0; job.status === 'deleting' && step < 30; step++) job = await library.advancePurge(job.id, uid); return job; }
function proxyBucket(overrides: Partial<R2Bucket>): R2Bucket { return new Proxy(bucket, { get(target, key) { if (key in overrides) return Reflect.get(overrides, key); const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } }); }

describe('failed media recovery through the existing reference-protected purge workflow', () => {
  it.each([false, true])('cleans %s-completed variants, releases used and reserved bytes exactly once, and fences old runners', async complete => {
    const failedJob = await failed(complete), task = failedJob.variants[0]!;
    let job = await checked(await begin()); expect(job.status).toBe('ready'); expect(job.recovery?.reservedBytes).toBe(source.length);
    job = await library.confirmPurge(job.id, uid);
    await expect(processing.claim(assetId, runId)).rejects.toMatchObject({ code: 'PROCESSING_CLEANUP_STARTED' });
    await expect(processing.part(assetId, runId, 'download', 1, request())).rejects.toMatchObject({ code: 'PROCESSING_CLEANUP_STARTED' });
    await expect(processing.completeVariant(assetId, runId, 'download')).rejects.toMatchObject({ code: 'PROCESSING_CLEANUP_STARTED' });
    await expect(processing.fail(assetId, runId, { code: 'OLD_RUN', message: 'stale' })).rejects.toMatchObject({ code: 'PROCESSING_CLEANUP_STARTED' });
    const abortStep = await library.advancePurge(job.id, uid); expect(abortStep).toMatchObject({ completedKeys: 0, recovery: { abortedUploads: 1 } });
    expect(await store.get<Quota>('system/media_quota')).toMatchObject({ usedBytes: source.length, reservedBytes: source.length });
    job = await deleted(abortStep); expect(job.status).toBe('deleted');
    expect(await bucket.head(`originals/${assetId}/source`)).toBeNull(); expect(await bucket.head(task.key)).toBeNull();
    await expect(bucket.resumeMultipartUpload(task.key, task.r2UploadId!).uploadPart(1, source)).rejects.toThrow();
    expect(await store.get<Quota>('system/media_quota')).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    expect(await store.get<ProcessingJob>(`processing/${assetId}`)).toMatchObject({ cleanupId: job.id, cleanedAt: now, reservedBytes: 0 });
    expect(await library.advancePurge(job.id, uid)).toEqual(job); expect(await library.confirmPurge(job.id, uid)).toEqual(job);
    expect((await store.list<{ action: string }>('audit', { limit: 50 })).items.filter(row => row.data.action === 'failed_media_cleaned')).toHaveLength(1);
    const upload = await new Media(store, bucket, () => now).start({ kind: 'file', originalName: 'retry.txt', expectedMime: 'text/plain', expectedBytes: source.length }, uid, crypto.randomUUID());
    expect(upload.assetId).not.toBe(assetId); await new Media(store, bucket, () => now).abort(upload.uploadId, uid);
  });
  it('retains original, multipart and quota when a historical revision references the failed asset', async () => {
    await failed(); await store.transaction(async tx => { tx.put('revisions/protected', { collection: 'creations', data: { coverAssetId: assetId } }); });
    const job = await checked(await begin()); expect(job.status).toBe('blocked');
    expect(await store.get<ProcessingJob>(`processing/${assetId}`)).not.toHaveProperty('cleanupId');
    expect(await bucket.head(`originals/${assetId}/source`)).not.toBeNull();
    expect(await store.get<Quota>('system/media_quota')).toMatchObject({ usedBytes: source.length, reservedBytes: source.length });
  });
  it('does not begin recovery while an upload lease is still active', async () => {
    await failed(); await store.transaction(async tx => { const job = (await tx.get<ProcessingJob>(`processing/${assetId}`))!; job.variants[0]!.leases['1'] = { token: 'still-running', expiresAt: now + 120_000 }; tx.put(`processing/${assetId}`, job); });
    await library.trash(assetId, { expectedVersion: 1 }, uid);
    await expect(library.startPurge(assetId, { expectedVersion: 2 }, uid, crypto.randomUUID())).rejects.toMatchObject({ code: 'MEDIA_PROCESSING_BUSY' });
    now += 120_001; expect((await library.startPurge(assetId, { expectedVersion: 2 }, uid, crypto.randomUUID())).status).toBe('checking');
  });
  it('retries ambiguous abort and delete acknowledgements without releasing quota early', async () => {
    await failed(); const job = await checked(await begin()); await library.confirmPurge(job.id, uid);
    const lostAbort = proxyBucket({ resumeMultipartUpload: (key, id) => { const upload = bucket.resumeMultipartUpload(key, id); return { key, uploadId: id, uploadPart: upload.uploadPart.bind(upload), complete: upload.complete.bind(upload), abort: async () => { await upload.abort(); throw new Error('abort acknowledgement lost'); } }; } });
    await expect(new MediaLibrary(store, lostAbort, () => now).advancePurge(job.id, uid)).rejects.toThrow('abort acknowledgement lost');
    expect((await library.getPurge(job.id, uid)).recovery?.abortedUploads).toBe(0); await library.advancePurge(job.id, uid);
    const lostDelete = proxyBucket({ delete: async key => { await bucket.delete(key); throw new Error('delete acknowledgement lost'); } });
    await expect(new MediaLibrary(store, lostDelete, () => now).advancePurge(job.id, uid)).rejects.toThrow('delete acknowledgement lost');
    expect(await store.get<Quota>('system/media_quota')).toMatchObject({ usedBytes: source.length, reservedBytes: source.length });
    expect((await deleted(await library.getPurge(job.id, uid))).status).toBe('deleted');
    expect(await store.get<Quota>('system/media_quota')).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
  });
  it('serializes progress accounting across concurrent advance calls and a lost final commit response', async () => {
    await failed(true); const job = await checked(await begin()); await library.confirmPurge(job.id, uid);
    await Promise.all([library.advancePurge(job.id, uid), library.advancePurge(job.id, uid)]);
    expect((await library.getPurge(job.id, uid)).recovery?.abortedUploads).toBe(1);
    await Promise.all([library.advancePurge(job.id, uid), library.advancePurge(job.id, uid)]);
    expect((await library.getPurge(job.id, uid)).completedKeys).toBe(1);
    let lose = true;
    const ambiguous: Store = { get: store.get.bind(store), getMany: store.getMany.bind(store), list: store.list.bind(store), transaction: async callback => { const result = await store.transaction(callback); if (lose && (result as PurgeJob).status === 'deleted') { lose = false; throw new Error('commit acknowledgement lost'); } return result; } };
    await expect(new MediaLibrary(ambiguous, bucket, () => now).advancePurge(job.id, uid)).rejects.toThrow('commit acknowledgement lost');
    expect((await library.advancePurge(job.id, uid)).status).toBe('deleted');
    expect(await store.get<Quota>('system/media_quota')).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    expect((await store.list<{ action: string }>('audit', { limit: 50 })).items.filter(row => row.data.action === 'failed_media_cleaned')).toHaveLength(1);
  });
  it('aborts the handle before an already-started completion can recreate a deleted object', async () => {
    const plan = await original(); await processing.plan(assetId, runId, plan); await processing.part(assetId, runId, 'download', 1, request());
    let enter!: () => void, resume!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; }), paused = new Promise<void>(resolve => { resume = resolve; });
    const delayed = proxyBucket({ resumeMultipartUpload: (key, id) => { const upload = bucket.resumeMultipartUpload(key, id); return { key, uploadId: id, uploadPart: upload.uploadPart.bind(upload), abort: upload.abort.bind(upload), complete: async parts => { enter(); await paused; return upload.complete(parts); } }; } });
    const oldRequest = new Processing(store, delayed, () => now).completeVariant(assetId, runId, 'download').then(() => 'unexpected success', () => 'fenced');
    await entered; await processing.fail(assetId, runId, { code: 'INTERRUPTED', message: 'synthetic failure' });
    await library.trash(assetId, { expectedVersion: 1 }, uid);
    await expect(library.startPurge(assetId, { expectedVersion: 2 }, uid, crypto.randomUUID())).rejects.toMatchObject({ code: 'MEDIA_PROCESSING_BUSY' });
    now += 120_001; const job = await checked(await library.startPurge(assetId, { expectedVersion: 2 }, uid, crypto.randomUUID())); await library.confirmPurge(job.id, uid);
    await library.advancePurge(job.id, uid); resume(); expect(await oldRequest).toBe('fenced');
    expect((await deleted(await library.getPurge(job.id, uid))).status).toBe('deleted'); expect(await bucket.head(`variants/${assetId}/${runId}/download`)).toBeNull();
  });
  it('preserves ambiguous multipart initialization and refuses automatic quota release or duplicate creation', async () => {
    const plan = await original(); let creates = 0;
    const uncertain = proxyBucket({ createMultipartUpload: async (...args) => { creates++; await bucket.createMultipartUpload(...args); throw new Error('create acknowledgement lost'); } });
    const runner = new Processing(store, uncertain, () => now);
    await expect(runner.plan(assetId, runId, plan)).rejects.toThrow('create acknowledgement lost');
    await expect(runner.plan(assetId, runId, plan)).rejects.toMatchObject({ code: 'VARIANT_INITIALIZATION_UNCERTAIN' }); expect(creates).toBe(1);
    await processing.fail(assetId, runId, { code: 'INITIALIZATION_UNKNOWN', message: 'synthetic failure' }); await library.trash(assetId, { expectedVersion: 1 }, uid);
    await expect(library.startPurge(assetId, { expectedVersion: 2 }, uid, crypto.randomUUID())).rejects.toMatchObject({ code: 'MEDIA_MULTIPART_UNCONFIRMED' });
    expect(await store.get<Quota>('system/media_quota')).toMatchObject({ usedBytes: source.length, reservedBytes: source.length });
  });
  it('fences an in-flight part upload after waiting for its lease and aborting the frozen handle', async () => {
    const plan = await original(); await processing.plan(assetId, runId, plan);
    let enter!: () => void, resume!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; }), paused = new Promise<void>(resolve => { resume = resolve; });
    const delayed = proxyBucket({ resumeMultipartUpload: (key, id) => { const upload = bucket.resumeMultipartUpload(key, id); return { key, uploadId: id, complete: upload.complete.bind(upload), abort: upload.abort.bind(upload), uploadPart: async (...args) => { enter(); await paused; return upload.uploadPart(...args); } }; } });
    const oldRequest = new Processing(store, delayed, () => now).part(assetId, runId, 'download', 1, request()).then(() => 'unexpected success', () => 'fenced');
    await entered; await processing.fail(assetId, runId, { code: 'INTERRUPTED', message: 'synthetic failure' }); await library.trash(assetId, { expectedVersion: 1 }, uid);
    await expect(library.startPurge(assetId, { expectedVersion: 2 }, uid, crypto.randomUUID())).rejects.toMatchObject({ code: 'MEDIA_PROCESSING_BUSY' });
    now += 120_001; const job = await checked(await library.startPurge(assetId, { expectedVersion: 2 }, uid, crypto.randomUUID())); await library.confirmPurge(job.id, uid);
    await library.advancePurge(job.id, uid); resume(); expect(await oldRequest).toBe('fenced');
    expect((await deleted(await library.getPurge(job.id, uid))).status).toBe('deleted'); expect(await store.get<Quota>('system/media_quota')).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
  });
  it('retains a known multipart handle across a lost database acknowledgement and does not create it twice', async () => {
    const plan = await original(); let lose = true, creates = 0;
    const ambiguous: Store = { get: store.get.bind(store), getMany: store.getMany.bind(store), list: store.list.bind(store), transaction: async callback => { const result = await store.transaction(callback); const current = await store.get<ProcessingJob>(`processing/${assetId}`); if (lose && current?.variants[0]?.r2UploadId) { lose = false; throw new Error('handle acknowledgement lost'); } return result; } };
    const counted = proxyBucket({ createMultipartUpload: async (...args) => { creates++; return bucket.createMultipartUpload(...args); } });
    const runner = new Processing(ambiguous, counted, () => now);
    await expect(runner.plan(assetId, runId, plan)).rejects.toThrow('handle acknowledgement lost');
    expect((await store.get<ProcessingJob>(`processing/${assetId}`))?.variants[0]?.r2UploadId).toBeTruthy();
    await runner.plan(assetId, runId, plan); expect(creates).toBe(1);
    await processing.fail(assetId, runId, { code: 'STOPPED', message: 'synthetic failure' });
    const job = await checked(await begin()); await library.confirmPurge(job.id, uid);
    expect((await deleted(await library.getPurge(job.id, uid))).status).toBe('deleted'); expect(await store.get<Quota>('system/media_quota')).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
  });
  it('immediately retries completion after a lost R2 acknowledgement and a transient reconciliation HEAD failure', async () => {
    const plan = await original(); await processing.plan(assetId, runId, plan); await processing.part(assetId, runId, 'download', 1, request());
    let heads = 0;
    const unreliable = proxyBucket({ head: async key => { if (++heads === 2) throw new Error('HEAD temporarily unavailable'); return bucket.head(key); }, resumeMultipartUpload: (key, id) => { const upload = bucket.resumeMultipartUpload(key, id); return { key, uploadId: id, uploadPart: upload.uploadPart.bind(upload), abort: upload.abort.bind(upload), complete: async parts => { await upload.complete(parts); throw new Error('complete acknowledgement lost'); } }; } });
    await expect(new Processing(store, unreliable, () => now).completeVariant(assetId, runId, 'download')).rejects.toThrow('HEAD temporarily unavailable');
    expect((await store.get<ProcessingJob>(`processing/${assetId}`))!.variants[0]).not.toHaveProperty('completionLease');
    expect(await processing.completeVariant(assetId, runId, 'download')).toMatchObject({ state: 'complete' });
  });
  it('immediately retries a completion whose final database transaction failed', async () => {
    const plan = await original(); await processing.plan(assetId, runId, plan); await processing.part(assetId, runId, 'download', 1, request());
    let lose = true;
    const unavailable: Store = { get: store.get.bind(store), getMany: store.getMany.bind(store), list: store.list.bind(store), transaction: callback => store.transaction(async tx => { const result = await callback(tx); if (lose && (result as { state?: string })?.state === 'complete') { lose = false; throw new Error('final transaction unavailable'); } return result; }) };
    await expect(new Processing(unavailable, bucket, () => now).completeVariant(assetId, runId, 'download')).rejects.toThrow('final transaction unavailable');
    expect((await store.get<ProcessingJob>(`processing/${assetId}`))!.variants[0]).not.toHaveProperty('completionLease');
    expect(await processing.completeVariant(assetId, runId, 'download')).toMatchObject({ state: 'complete' });
  });
  it('rejects changed processing state between reference check and confirmation', async () => {
    await failed(); const job = await checked(await begin());
    await store.transaction(async tx => { const current = (await tx.get<ProcessingJob>(`processing/${assetId}`))!; tx.put(`processing/${assetId}`, { ...current, updatedAt: now + 1 }); });
    await expect(library.confirmPurge(job.id, uid)).rejects.toMatchObject({ code: 'PROCESSING_CHANGED' });
    expect(await store.get<ProcessingJob>(`processing/${assetId}`)).not.toHaveProperty('cleanupId'); expect(await bucket.head(`originals/${assetId}/source`)).not.toBeNull();
  });
  it('requires an absence read after successful deletion before advancing or settling quota', async () => {
    await failed(); const job = await checked(await begin()); await library.confirmPurge(job.id, uid); await library.advancePurge(job.id, uid);
    const ineffective = proxyBucket({ delete: async () => {} });
    await expect(new MediaLibrary(store, ineffective, () => now).advancePurge(job.id, uid)).rejects.toMatchObject({ code: 'MEDIA_DELETE_UNCONFIRMED' });
    expect((await library.getPurge(job.id, uid)).completedKeys).toBe(0); expect(await store.get<Quota>('system/media_quota')).toMatchObject({ usedBytes: source.length, reservedBytes: source.length });
  });
  it('stops on changed object identity and retains accounting after partial deletion', async () => {
    const failedJob = await failed(true); const job = await checked(await begin()); await library.confirmPurge(job.id, uid);
    await library.advancePurge(job.id, uid); await library.advancePurge(job.id, uid);
    await bucket.put(failedJob.variants[0]!.key, 'different object');
    await expect(library.advancePurge(job.id, uid)).rejects.toMatchObject({ code: 'MEDIA_OBJECT_CHANGED' });
    expect(await store.get<Quota>('system/media_quota')).toMatchObject({ usedBytes: source.length, reservedBytes: source.length });
  });
});
