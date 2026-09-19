import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MEDIA_LIMITS } from '@xvyin/contracts';
import { Media, type Upload } from '../src/media';
import { MemoryStore } from '../src/store/memory';
import type { Transaction } from '../src/store/types';

class FaultStore extends MemoryStore {
  calls = 0;
  failBefore = new Set<number>();
  loseAcknowledgement = new Set<number>();
  override async transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    const call = ++this.calls;
    if (this.failBefore.has(call)) throw new Error('database unavailable before commit');
    const result = await super.transaction(callback);
    if (this.loseAcknowledgement.has(call)) throw new Error('database commit acknowledgement lost');
    return result;
  }
}

let mf: Miniflare, actualBucket: R2Bucket, store: FaultStore, media: Media, creates: number, now: number;
const metadata = { kind: 'image' as const, originalName: 'start-test.jpg', expectedMime: 'image/jpeg', expectedBytes: 32 };
let beforeCreate: (() => Promise<void>) | undefined, loseR2Acknowledgement: boolean;
beforeAll(async () => {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("upload start test"); } }', compatibilityDate: '2026-09-11', r2Buckets: ['MEDIA'] }), telemetry: { enabled: false }, cf: false });
  actualBucket = await mf.getR2Bucket('MEDIA') as unknown as R2Bucket;
});
beforeEach(() => {
  creates = 0; now = Date.UTC(2026, 8, 13); beforeCreate = undefined; loseR2Acknowledgement = false; store = new FaultStore();
  const bucket = new Proxy(actualBucket, {
    get(target, property) {
      if (property === 'createMultipartUpload') return async (key: string, options?: R2MultipartOptions) => {
        creates++; await beforeCreate?.();
        const result = await target.createMultipartUpload(key, options);
        if (loseR2Acknowledgement) throw new Error('R2 create succeeded but acknowledgement was lost');
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  media = new Media(store, bucket, () => now);
});
afterAll(async () => { await mf.dispose(); });

async function expectOneReservation() {
  expect((await media.quota()).reservedBytes).toBe(metadata.expectedBytes);
  expect((await store.list('upload_reservations')).items).toHaveLength(1);
  expect((await store.list('upload_start_requests')).items).toHaveLength(1);
  expect(creates).toBe(1);
}

describe('idempotent upload start with real R2 multipart initialization', () => {
  it('admits a 100 MB image using existing bounded parts, and rejects one byte over', async () => {
    const upload = await media.start({ ...metadata, expectedBytes: 100_000_000 }, 'admin');
    expect(upload.partSize).toBe(5 * 1024 * 1024); expect(upload.totalParts).toBe(20);
    await expect(media.start({ ...metadata, expectedBytes: 100_000_001 }, 'admin')).rejects.toHaveProperty('name', 'ZodError');
    await media.abort(upload.uploadId, 'admin');
    expect(await media.quota()).toMatchObject({ reservedBytes: 0, usedBytes: 0 });
  });

  it('streams a full 100 MB upload through 20 real R2 parts and reconciles completion once', async () => {
    const upload = await media.start({ ...metadata, expectedBytes: 100_000_000 }, 'admin');
    for (let part = 1; part <= upload.totalParts; part++) {
      const bytes = Math.min(upload.partSize, 100_000_000 - (part - 1) * upload.partSize);
      const body = new Uint8Array(bytes); body[0] = part;
      await media.part(upload.uploadId, part, new Request('https://test.invalid/upload', { method: 'PUT', body }), 'admin');
    }
    const asset = await media.complete(upload.uploadId, 'admin');
    expect(asset).toMatchObject({ originalBytes: 100_000_000, status: 'processing' });
    expect((await actualBucket.head(asset.originalKey))?.size).toBe(100_000_000);
    expect(await media.complete(upload.uploadId, 'admin')).toEqual(asset);
    expect(await media.quota()).toMatchObject({ usedBytes: 100_000_000, reservedBytes: 0 });
    await actualBucket.delete(asset.originalKey);
  }, 60_000);

  it('reports the effective free media budget for an older quota without deleting stored files', async () => {
    await store.transaction(async tx => { tx.put('system/media_quota', { usedBytes: 9_500_000_000, reservedBytes: 0, limitBytes: 10_000_000_000 }); });
    expect(await media.quota()).toEqual({ usedBytes: 9_500_000_000, reservedBytes: 0, limitBytes: 9_000_000_000 });
    await expect(media.start(metadata, 'admin')).rejects.toMatchObject({ code: 'MEDIA_QUOTA_EXCEEDED' });
    expect((await media.quota()).usedBytes).toBe(9_500_000_000);
  });

  it('returns the original upload after a lost HTTP response without reserving twice', async () => {
    const key = crypto.randomUUID(), first = await media.start(metadata, 'admin', key);
    // The client did not receive first, so sends the identical POST again.
    expect(await media.start(metadata, 'admin', key)).toEqual(first);
    await expectOneReservation();
    const part = await actualBucket.resumeMultipartUpload(first.key, first.r2UploadId).uploadPart(1, new Uint8Array(metadata.expectedBytes));
    expect(part.etag).toBeTruthy();
  });

  it('allows exactly one initializer for concurrent requests using the same key', async () => {
    let signalEntered!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { signalEntered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    beforeCreate = async () => { signalEntered(); await blocked; };
    const key = crypto.randomUUID(), first = media.start(metadata, 'admin', key);
    await entered;
    await expect(media.start(metadata, 'admin', key)).rejects.toMatchObject({ code: 'UPLOAD_INITIALIZING', status: 409 });
    release(); const upload = await first;
    expect(await media.start(metadata, 'admin', key)).toEqual(upload);
    await expectOneReservation();
  });

  it('rejects key reuse with a changed payload before creating or reserving again', async () => {
    const key = crypto.randomUUID(); await media.start(metadata, 'admin', key);
    await expect(media.start({ ...metadata, originalName: 'different.jpg' }, 'admin', key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    await expectOneReservation();
  });

  it('scopes request keys to the authenticated administrator', async () => {
    const key = crypto.randomUUID(), first = await media.start(metadata, 'admin-a', key), second = await media.start(metadata, 'admin-b', key);
    expect(second.uploadId).not.toBe(first.uploadId); expect(creates).toBe(2);
    expect((await media.quota()).reservedBytes).toBe(2 * metadata.expectedBytes);
  });

  it('retries a reservation whose database acknowledgement was lost before any R2 call', async () => {
    const key = crypto.randomUUID(); store.loseAcknowledgement.add(1);
    await expect(media.start(metadata, 'admin', key)).rejects.toThrow('acknowledgement lost');
    expect(creates).toBe(0);
    await media.start(metadata, 'admin', key); await expectOneReservation();
  });

  it('reconciles a final database commit whose acknowledgement was lost', async () => {
    store.loseAcknowledgement.add(3);
    const key = crypto.randomUUID(), upload = await media.start(metadata, 'admin', key);
    expect(await media.start(metadata, 'admin', key)).toEqual(upload);
    await expectOneReservation();
  });

  it('retains a known R2 handle after a failed final commit and restores it on the next request', async () => {
    const key = crypto.randomUUID(); store.failBefore.add(3);
    await expect(media.start(metadata, 'admin', key)).rejects.toMatchObject({ code: 'UPLOAD_RECONCILING', status: 409 });
    const receipt = (await store.list<{ r2UploadId: string; state: string }>('upload_start_requests')).items[0]!.data;
    expect(receipt.state).toBe('uncertain'); expect(receipt.r2UploadId).toBeTruthy();
    const upload = await media.start(metadata, 'admin', key);
    expect(upload.r2UploadId).toBe(receipt.r2UploadId); await expectOneReservation();
  });

  it('does not recreate or release quota when R2 creation acknowledgement is uncertain', async () => {
    const key = crypto.randomUUID(); loseR2Acknowledgement = true;
    await expect(media.start(metadata, 'admin', key)).rejects.toMatchObject({ code: 'UPLOAD_INITIALIZATION_UNCERTAIN', status: 409 });
    loseR2Acknowledgement = false;
    await expect(media.start(metadata, 'admin', key)).rejects.toMatchObject({ code: 'UPLOAD_INITIALIZATION_UNCERTAIN', status: 409 });
    expect((await store.list<Upload>('uploads')).items).toHaveLength(0); await expectOneReservation();
  });

  it('never reclaims an ambiguous initialization claim after its acknowledgement is lost', async () => {
    const key = crypto.randomUUID(); store.loseAcknowledgement.add(2);
    await expect(media.start(metadata, 'admin', key)).rejects.toThrow('acknowledgement lost');
    await expect(media.start(metadata, 'admin', key)).rejects.toMatchObject({ code: 'UPLOAD_INITIALIZING' });
    now += 120_000;
    await expect(media.start(metadata, 'admin', key)).rejects.toMatchObject({ code: 'UPLOAD_INITIALIZATION_UNCERTAIN' });
    expect(creates).toBe(0); expect((await media.quota()).reservedBytes).toBe(metadata.expectedBytes);
  });

  it('preserves the quota boundary for competing keys while retries consume only one reservation', async () => {
    await store.transaction(async tx => { await tx.get('system/media_quota'); tx.put('system/media_quota', { usedBytes: MEDIA_LIMITS.totalBytes - metadata.expectedBytes, reservedBytes: 0, limitBytes: MEDIA_LIMITS.totalBytes }); });
    const firstKey = crypto.randomUUID(), secondKey = crypto.randomUUID();
    const results = await Promise.allSettled([media.start(metadata, 'admin', firstKey), media.start(metadata, 'admin', secondKey)]);
    const success = results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Upload>;
    const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(success).toBeTruthy(); expect(failure.reason).toMatchObject({ code: 'MEDIA_QUOTA_EXCEEDED' });
    const successfulKey = results[0]!.status === 'fulfilled' ? firstKey : secondKey;
    expect(await media.start(metadata, 'admin', successfulKey)).toEqual(success.value); await expectOneReservation();
  });

  it('validates request keys and keeps callers without a key compatible', async () => {
    await expect(media.start(metadata, 'admin', 'not-a-uuid')).rejects.toThrow(); expect(creates).toBe(0);
    const first = await media.start(metadata, 'admin'), second = await media.start(metadata, 'admin');
    expect(first.uploadId).not.toBe(second.uploadId); expect(creates).toBe(2);
  });
});
