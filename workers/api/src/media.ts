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
}
const defaultQuota = (): Quota => ({ usedBytes: 0, reservedBytes: 0, limitBytes: MEDIA_LIMITS.totalBytes });
export class Media {
  constructor(readonly store: Store, readonly bucket: R2Bucket, readonly now: () => number) {}
  async quota(): Promise<Quota> { return await this.store.get<Quota>('system/media_quota') || defaultQuota(); }
  async start(input: unknown, uid: string): Promise<Upload> {
    const metadata = UploadMetadataSchema.parse(input), uploadId = crypto.randomUUID(), assetId = crypto.randomUUID(), key = `originals/${assetId}/source`;
    // Reserve before creating R2 state; an orphan always retains its reservation until reconciliation.
    await this.store.transaction(async tx => {
      const quota = await tx.get<Quota>('system/media_quota') || defaultQuota();
      assert(canReserveMediaBytes(quota.usedBytes, quota.reservedBytes, metadata.expectedBytes), 'MEDIA_QUOTA_EXCEEDED', 409, '媒体总容量将超过 10 GB');
      tx.put('system/media_quota', { ...quota, reservedBytes: quota.reservedBytes + metadata.expectedBytes });
      tx.put(`upload_reservations/${uploadId}`, { bytes: metadata.expectedBytes, key, createdAt: this.now(), state: 'reserved' });
    });
    const multipart = await this.bucket.createMultipartUpload(key, { httpMetadata: { contentType: 'application/octet-stream' } });
    const upload: Upload = { uploadId, assetId, key, r2UploadId: multipart.uploadId, metadata, partSize: PART_SIZE, totalParts: Math.ceil(metadata.expectedBytes / PART_SIZE), expiresAt: this.now() + 24 * 3600_000, state: 'uploading', parts: [], leases: {}, authorUid: uid };
    await this.store.transaction(async tx => { await tx.get(`uploads/${uploadId}`); tx.put(`uploads/${uploadId}`, upload); });
    return upload;
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
      const current = await tx.get<Upload>(`uploads/${id}`);
      assert(current?.state === 'uploading', 'UPLOAD_STATE_CONFLICT', 409, '上传状态已改变');
      assert(!current.leases[partNumber] || current.leases[partNumber]!.expiresAt <= now, 'PART_BUSY', 409, '这个分片正在上传，请稍后重试');
      tx.put(`uploads/${id}`, { ...current, leases: { ...current.leases, [partNumber]: { token, expiresAt: now + 120_000 } } });
    });
    const result = await this.bucket.resumeMultipartUpload(upload.key, upload.r2UploadId).uploadPart(partNumber, data);
    const part: UploadPart = { partNumber, etag: result.etag, bytes };
    await this.store.transaction(async tx => {
      const current = await tx.get<Upload>(`uploads/${id}`);
      assert(current?.state === 'uploading' && current.leases[partNumber]?.token === token, 'UPLOAD_STATE_CONFLICT', 409, '上传状态已改变，请刷新');
      const leases = { ...current.leases }; delete leases[partNumber];
      tx.put(`uploads/${id}`, { ...current, leases, parts: [...current.parts.filter(p => p.partNumber !== partNumber), part].sort((a, b) => a.partNumber - b.partNumber) });
    });
    return part;
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
