import { z } from 'zod';
import { UploadMetadataSchema, DetectedMediaMetadataSchema, MEDIA_LIMITS, canReserveMediaBytes, type UploadMetadata, type DetectedMediaMetadata, type PublicMediaVariant } from '@xvyin/contracts';
import type { Store } from './store/types';
import { assert } from './errors';
export const PART_SIZE = 5 * 1024 * 1024;
export interface Quota { usedBytes: number; reservedBytes: number; limitBytes: number }
export interface UploadPart { partNumber: number; etag: string; bytes: number }
export interface Upload {
  uploadId: string; assetId: string; r2UploadId: string; key: string; metadata: UploadMetadata;
  partSize: number; totalParts: number; expiresAt: number; state: 'uploading' | 'completing' | 'processing' | 'aborting' | 'aborted';
  parts: UploadPart[]; leases: Record<string, { token: string; expiresAt: number }>; authorUid: string;
}
export interface MediaAsset {
  id: string; kind: UploadMetadata['kind']; originalName: string; originalKey: string; originalBytes: number;
  expectedMime: string; expectedSha256?: string; status: 'processing' | 'ready' | 'failed';
  metadata?: DetectedMediaMetadata; variants: Array<PublicMediaVariant & { key: string; sha256: string }>;
  createdAt: string; updatedAt: string; error?: { code: string; message: string };
  version?: number; category?: string; lifecycle?: 'active' | 'trash' | 'purging' | 'deleted'; trashedAt?: string; deletedAt?: string; purgeJobId?: string;
}
const defaultQuota = (): Quota => ({ usedBytes: 0, reservedBytes: 0, limitBytes: MEDIA_LIMITS.totalBytes });
export class Media {
  constructor(readonly store: Store, readonly bucket: R2Bucket, readonly now: () => number) {}
  async quota(): Promise<Quota> {
    // Existing quota documents may predate the free-tier reserve. The effective
    // limit is code-owned; never display a stale 10 GB as media availability.
    return { ...(await this.store.get<Quota>('system/media_quota') || defaultQuota()), limitBytes: MEDIA_LIMITS.totalBytes };
  }
  async start(input: unknown, uid: string, idempotencyKey?: string): Promise<Upload> {
    type Receipt = { uploadId: string; assetId: string; key: string; authorUid: string; payloadHash: string; createdAt: number; state: 'reserved' | 'initializing' | 'uncertain' | 'ready'; token?: string; initializedAt?: number; r2UploadId?: string };
    const metadata = UploadMetadataSchema.parse(input), requestKey = z.string().uuid().parse(idempotencyKey ?? crypto.randomUUID());
    const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const [receiptId, payloadHash] = await Promise.all([hash(JSON.stringify([uid, requestKey])), hash(JSON.stringify(metadata))]);
    const receiptPath = `upload_start_requests/${receiptId}`, token = crypto.randomUUID();
    // Commit the receipt and quota together, before claiming the R2 side effect.
    // A lost reservation acknowledgement is safe to retry from state reserved.
    let receipt = await this.store.transaction(async tx => {
      const prior = await tx.get<Receipt>(receiptPath);
      if (prior) {
        assert(prior.authorUid === uid && prior.payloadHash === payloadHash, 'IDEMPOTENCY_CONFLICT', 409, '这个上传请求标识已用于另一份文件，请刷新后重新选择文件');
        return prior;
      }
      const quota = await tx.get<Quota>('system/media_quota') || defaultQuota();
      assert(canReserveMediaBytes(quota.usedBytes, quota.reservedBytes, metadata.expectedBytes), 'MEDIA_QUOTA_EXCEEDED', 409, '媒体原件、衍生版本与上传预留合计最多 9 GB；另留 1 GB 给网站发布。请先整理媒体空间。');
      const uploadId = crypto.randomUUID(), assetId = crypto.randomUUID(), key = `originals/${assetId}/source`;
      const created: Receipt = { uploadId, assetId, key, authorUid: uid, payloadHash, createdAt: this.now(), state: 'reserved' };
      tx.put('system/media_quota', { ...quota, limitBytes: MEDIA_LIMITS.totalBytes, reservedBytes: quota.reservedBytes + metadata.expectedBytes });
      tx.put(`upload_reservations/${uploadId}`, { bytes: metadata.expectedBytes, key, createdAt: created.createdAt, state: 'reserved' });
      tx.put(receiptPath, created); return created;
    });
    const existingUpload = async () => {
      const existing = await this.store.get<Upload>(`uploads/${receipt.uploadId}`);
      assert(existing?.authorUid === uid, 'UPLOAD_RECONCILING', 409, '上传结果正在核对，请使用同一请求重试'); return existing;
    };
    if (receipt.state === 'ready') return existingUpload();
    receipt = await this.store.transaction(async tx => {
      const current = await tx.get<Receipt>(receiptPath);
      assert(current?.payloadHash === payloadHash && current.authorUid === uid, 'UPLOAD_RECONCILING', 409, '上传结果正在核对，请使用同一请求重试');
      if (current.state !== 'reserved') return current;
      const claimed: Receipt = { ...current, state: 'initializing', token, initializedAt: this.now() };
      tx.put(receiptPath, claimed); return claimed;
    });
    if (receipt.state === 'ready') return existingUpload();
    // A durable known R2 handle can be reconciled without creating another upload.
    // An ambiguous create cannot: retain its reservation until manual reconciliation.
    if (!receipt.r2UploadId) {
      assert(receipt.state !== 'uncertain' && !(receipt.state === 'initializing' && this.now() - receipt.initializedAt! >= 120_000), 'UPLOAD_INITIALIZATION_UNCERTAIN', 409, '上传初始化结果待恢复，容量预占已保留；请勿更换请求标识重复创建，请联系管理员核对');
      assert(receipt.token === token, 'UPLOAD_INITIALIZING', 409, '同一上传正在初始化，请稍后使用同一请求重试');
      try {
        const multipart = await this.bucket.createMultipartUpload(receipt.key, { httpMetadata: { contentType: 'application/octet-stream' } });
        receipt = { ...receipt, r2UploadId: multipart.uploadId };
      } catch {
        await this.store.transaction(async tx => {
          const current = await tx.get<Receipt>(receiptPath);
          if (current?.state === 'initializing' && current.token === token) tx.put(receiptPath, { ...current, state: 'uncertain' });
        }).catch(() => {});
        assert(false, 'UPLOAD_INITIALIZATION_UNCERTAIN', 409, '上传初始化结果待恢复，容量预占已保留；请勿更换请求标识重复创建，请联系管理员核对');
      }
    }
    const upload: Upload = { uploadId: receipt.uploadId, assetId: receipt.assetId, key: receipt.key, r2UploadId: receipt.r2UploadId!, metadata, partSize: PART_SIZE, totalParts: Math.ceil(metadata.expectedBytes / PART_SIZE), expiresAt: receipt.createdAt + 24 * 3600_000, state: 'uploading', parts: [], leases: {}, authorUid: uid };
    const finalize = () => this.store.transaction(async tx => {
      const current = await tx.get<Receipt>(receiptPath), existing = await tx.get<Upload>(`uploads/${receipt.uploadId}`);
      assert(current?.payloadHash === payloadHash && current.authorUid === uid, 'UPLOAD_RECONCILING', 409, '上传结果正在核对，请使用同一请求重试');
      if (current.state === 'ready') { assert(existing?.authorUid === uid, 'UPLOAD_RECONCILING', 409, '上传结果正在核对'); return existing; }
      assert(current.token === receipt.token && (!current.r2UploadId || current.r2UploadId === receipt.r2UploadId), 'UPLOAD_RECONCILING', 409, '上传初始化结果正在核对');
      tx.put(`uploads/${receipt.uploadId}`, upload); tx.put(receiptPath, { ...current, state: 'ready', r2UploadId: receipt.r2UploadId }); return upload;
    });
    try { return await finalize(); } catch {
      // Reconcile a lost commit acknowledgement with one read, not another full
      // transaction retry: contention must still fit the free request budget.
      const current = await this.store.get<Receipt>(receiptPath).catch(() => null);
      if (current?.state === 'ready') return existingUpload();
      await this.store.transaction(async tx => {
        const latest = await tx.get<Receipt>(receiptPath);
        if (latest?.state === 'initializing' && latest.token === receipt.token) tx.put(receiptPath, { ...latest, state: 'uncertain', r2UploadId: receipt.r2UploadId });
      }).catch(() => {});
      assert(false, 'UPLOAD_RECONCILING', 409, '上传结果正在核对，容量预占已保留；请稍后使用同一请求重试');
    }
  }
  async get(id: string, uid: string): Promise<Upload> {
    const upload = await this.store.get<Upload>(`uploads/${id}`);
    assert(upload && upload.authorUid === uid, 'NOT_FOUND', 404, '上传任务不存在'); return upload;
  }
  async part(id: string, partNumber: number, request: Request, uid: string): Promise<UploadPart> {
    const upload = await this.get(id, uid), now = this.now(), token = crypto.randomUUID();
    assert(upload.state === 'uploading' && upload.expiresAt > now, 'UPLOAD_EXPIRED', 409, '上传已结束或过期');
    assert(Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= upload.totalParts, 'INVALID_PART', 422, '分片编号无效');
    const expected = Math.min(upload.partSize, upload.metadata.expectedBytes - (partNumber - 1) * upload.partSize);
    const declared = request.headers.get('content-length');
    assert(!declared || Number(declared) === expected, 'PART_SIZE_MISMATCH', 422, '分片大小不匹配');
    const reader = request.body?.getReader(); assert(reader, 'EMPTY_PART', 400, '分片为空');
    const data = new Uint8Array(expected); let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        assert(bytes + next.value.byteLength <= expected, 'PART_SIZE_MISMATCH', 413, '分片超过允许大小');
        data.set(next.value, bytes); bytes += next.value.byteLength;
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    assert(bytes === expected, 'PART_SIZE_MISMATCH', 422, '分片未完整上传');
    await this.store.transaction(async tx => {
      const current = await tx.get<Upload>(`uploads/${id}`), claimedAt = this.now();
      assert(current?.state === 'uploading', 'UPLOAD_STATE_CONFLICT', 409, '上传状态已改变');
      assert(current.expiresAt > claimedAt, 'UPLOAD_EXPIRED', 409, '上传已结束或过期');
      assert(!current.leases[partNumber] || current.leases[partNumber]!.expiresAt <= claimedAt, 'PART_BUSY', 409, '这个分片正在上传，请稍后重试');
      tx.put(`uploads/${id}`, { ...current, leases: { ...current.leases, [partNumber]: { token, expiresAt: claimedAt + 120_000 } } });
    });
    try {
      const result = await this.bucket.resumeMultipartUpload(upload.key, upload.r2UploadId).uploadPart(partNumber, data);
      const part: UploadPart = { partNumber, etag: result.etag, bytes };
      await this.store.transaction(async tx => {
        const current = await tx.get<Upload>(`uploads/${id}`);
        assert(current?.state === 'uploading' && current.leases[partNumber]?.token === token, 'UPLOAD_STATE_CONFLICT', 409, '上传状态已改变，请刷新');
        const leases = { ...current.leases }; delete leases[partNumber];
        tx.put(`uploads/${id}`, { ...current, leases, parts: [...current.parts.filter(p => p.partNumber !== partNumber), part].sort((a, b) => a.partNumber - b.partNumber) });
      });
      return part;
    } catch (error) {
      // A lost acknowledgement can safely retry this part; don't force a two-minute
      // lease wait after a known failed transfer. Never remove another request's lease.
      await this.store.transaction(async tx => {
        const current = await tx.get<Upload>(`uploads/${id}`);
        if (current?.state === 'uploading' && current.leases[partNumber]?.token === token) {
          const leases = { ...current.leases }; delete leases[partNumber]; tx.put(`uploads/${id}`, { ...current, leases });
        }
      }).catch(() => {});
      throw error;
    }
  }
  async complete(id: string, uid: string): Promise<MediaAsset> {
    const upload = await this.get(id, uid);
    if (upload.state === 'processing') { const existing = await this.store.get<MediaAsset>(`media/${upload.assetId}`); assert(existing, 'UPLOAD_RECONCILING', 409, '上传结果正在核对'); return existing; }
    const current = await this.store.transaction(async tx => {
      const current = await tx.get<Upload>(`uploads/${id}`);
      assert(current && ['uploading', 'completing'].includes(current.state), 'UPLOAD_STATE_CONFLICT', 409, '上传状态已改变');
      assert(current.parts.length === current.totalParts && Object.keys(current.leases).length === 0, 'UPLOAD_INCOMPLETE', 409, '仍有分片尚未上传完成');
      tx.put(`uploads/${id}`, { ...current, state: 'completing' }); return current;
    });
    // HEAD reconciles a previous successful R2 completion whose acknowledgement was lost.
    let object = await this.bucket.head(current.key);
    if (!object) object = await this.bucket.resumeMultipartUpload(current.key, current.r2UploadId).complete(current.parts.map(({ partNumber, etag }) => ({ partNumber, etag })));
    assert(object.size === current.metadata.expectedBytes, 'UPLOAD_SIZE_MISMATCH', 422, '实际文件大小与声明不符');
    const at = new Date(this.now()).toISOString();
    const asset: MediaAsset = { id: current.assetId, kind: current.metadata.kind, originalName: current.metadata.originalName, originalKey: current.key, originalBytes: object.size, expectedMime: current.metadata.expectedMime, ...(current.metadata.expectedSha256 ? { expectedSha256: current.metadata.expectedSha256 } : {}), status: 'processing', variants: [], createdAt: at, updatedAt: at };
    return this.store.transaction(async tx => {
      const latest = await tx.get<Upload>(`uploads/${id}`), quota = await tx.get<Quota>('system/media_quota') || defaultQuota();
      const already = await tx.get<MediaAsset>(`media/${asset.id}`);
      if (already) return already;
      assert(latest?.state === 'completing', 'UPLOAD_STATE_CONFLICT', 409, '上传状态已改变');
      tx.put(`media/${asset.id}`, asset); tx.put(`uploads/${id}`, { ...latest, state: 'processing' });
      tx.put('system/media_quota', { ...quota, reservedBytes: quota.reservedBytes - asset.originalBytes, usedBytes: quota.usedBytes + asset.originalBytes });
      tx.delete(`upload_reservations/${id}`); return asset;
    });
  }
  async abort(id: string, uid: string): Promise<void> {
    const upload = await this.get(id, uid); if (upload.state === 'aborted') return;
    await this.store.transaction(async tx => {
      const current = await tx.get<Upload>(`uploads/${id}`);
      assert(current && ['uploading', 'aborting'].includes(current.state), 'UPLOAD_STATE_CONFLICT', 409, '已完成的上传不能取消');
      assert(Object.values(current.leases).every(lease => lease.expiresAt <= this.now()), 'PART_BUSY', 409, '分片仍在上传，请结束后再取消');
      tx.put(`uploads/${id}`, { ...current, state: 'aborting' });
    });
    await this.bucket.resumeMultipartUpload(upload.key, upload.r2UploadId).abort();
    await this.store.transaction(async tx => {
      const current = await tx.get<Upload>(`uploads/${id}`), quota = await tx.get<Quota>('system/media_quota') || defaultQuota();
      if (current?.state === 'aborted') return;
      assert(current?.state === 'aborting', 'UPLOAD_STATE_CONFLICT', 409, '上传状态已改变');
      tx.put(`uploads/${id}`, { ...current, state: 'aborted' }); tx.delete(`upload_reservations/${id}`);
      tx.put('system/media_quota', { ...quota, reservedBytes: quota.reservedBytes - current.metadata.expectedBytes });
    });
  }
  publicUpload(upload: Upload) {
    const { uploadId, assetId, partSize, totalParts, expiresAt, state, parts, metadata } = upload;
    return { uploadId, assetId, partSize, totalParts, expiresAt, state, parts, metadata };
  }
}
