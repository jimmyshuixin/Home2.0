import { z } from 'zod';
import { canReserveMediaBytes, DetectedMediaMetadataSchema, IdSchema, MEDIA_LIMITS, MediaVariantRoleSchema, PublicMediaVariantSchema, Sha256Schema, UploadMetadataSchema, type DetectedMediaMetadata, type UploadMetadata } from '@xvyin/contracts';
import { assert } from './errors';
import { PART_SIZE, type MediaAsset, type Quota } from './media';
import { sha256 } from './security';
import type { Store } from './store/types';

export const ProcessingVariantSchema = PublicMediaVariantSchema.omit({ url: true }).extend({ sha256: Sha256Schema }).strict();
export const PlannedProcessingVariantSchema = ProcessingVariantSchema.extend({ partSha256: z.array(Sha256Schema).min(1).max(98), multipartEtag: z.string().regex(/^[a-f0-9]{32}-[1-9]\d?$/) }).strict().refine(value => value.partSha256.length === Math.ceil(value.bytes / PART_SIZE) && value.multipartEtag.endsWith(`-${value.partSha256.length}`), '分片摘要数量与完整文件大小不一致');
export const ProcessingPlanSchema = z.object({ metadata: DetectedMediaMetadataSchema, variants: z.array(PlannedProcessingVariantSchema).min(1).max(7) }).strict();
export type ProcessingVariant = z.infer<typeof ProcessingVariantSchema>;
type Role = ProcessingVariant['role'];
interface Lease { token: string; expiresAt: number }
export interface ProcessingPart { partNumber: number; etag: string; bytes: number; sha256: string }
export interface VariantTask extends ProcessingVariant {
  partSha256: string[]; multipartEtag: string;
  key: string; partSize: number; totalParts: number; state: 'planned' | 'uploading' | 'completing' | 'complete';
  r2UploadId?: string; initializing?: Lease; parts: ProcessingPart[]; leases: Record<string, Lease>;
  verified?: { proof: 'verified-parts-r2-order'; bytes: number; version: string; etag: string };
}
export interface ProcessingJob {
  assetId: string; runId: string; state: 'claimed' | 'planned' | 'ready' | 'failed';
  originalVersion: string; originalEtag: string; metadata?: DetectedMediaMetadata; planHash?: string;
  reservedBytes: number; variants: VariantTask[]; createdAt: number; updatedAt: number;
  error?: { code: string; message: string };
}
const freshQuota = (): Quota => ({ usedBytes: 0, reservedBytes: 0, limitBytes: MEDIA_LIMITS.totalBytes });
const active = (lease: Lease, now: number) => lease.expiresAt > now;
function ids(assetId: string, runId: string) { IdSchema.parse(assetId); IdSchema.parse(runId); }
function assertRun(job: ProcessingJob | null, runId: string): asserts job is ProcessingJob { assert(job && job.runId === runId, 'PROCESSING_RUN_MISMATCH', 409, '媒体处理任务不属于当前运行'); }
function taskFor(job: ProcessingJob, role: Role): VariantTask { const task = job.variants.find(item => item.role === role); assert(task, 'VARIANT_NOT_PLANNED', 404, '此衍生文件不在处理计划内'); return task; }
function replaceTask(job: ProcessingJob, task: VariantTask, now: number): ProcessingJob { return { ...job, updatedAt: now, variants: job.variants.map(item => item.role === task.role ? task : item) }; }
function uploadDeclaration(asset: MediaAsset): UploadMetadata {
  return UploadMetadataSchema.parse({ kind: asset.kind, originalName: asset.originalName, expectedMime: asset.expectedMime, expectedBytes: asset.originalBytes, ...(asset.expectedSha256 ? { expectedSha256: asset.expectedSha256 } : {}) });
}
function checkVariants(metadata: DetectedMediaMetadata, variants: ProcessingVariant[]): void {
  const roles = new Set(variants.map(item => item.role));
  assert(roles.size === variants.length, 'DUPLICATE_VARIANT', 422, '衍生文件用途不可重复');
  const expected: Role[] = metadata.kind === 'image' ? ['thumb', 'content', 'large'] : metadata.kind === 'video' ? ['playback', 'poster'] : metadata.kind === 'audio' ? ['playback'] : metadata.detectedMime === 'text/vtt' ? ['download', 'captions'] : ['download'];
  assert(expected.length === roles.size && expected.every(role => roles.has(role)), 'MISSING_VARIANT', 422, '媒体缺少必要的完整衍生版本');
  for (const item of variants) {
    if (['thumb', 'content', 'large', 'poster'].includes(item.role)) {
      assert(item.mime === 'image/webp' && item.width && item.height && item.width * item.height <= MEDIA_LIMITS.imagePixels && item.bytes <= MEDIA_LIMITS.imageBytes && item.durationMs === undefined, 'INVALID_VARIANT', 422, '图片版本需要正确的 WebP 格式与尺寸');
      const bound = item.role === 'thumb' ? 384 : item.role === 'content' ? 960 : item.role === 'large' ? 1600 : 1920;
      assert(Math.max(item.width, item.height) <= bound, 'INVALID_VARIANT', 422, '图片版本超过约定尺寸');
    } else if (item.role === 'playback') {
      assert(item.durationMs && 'durationMs' in metadata && Math.abs(item.durationMs - metadata.durationMs) <= Math.max(500, metadata.durationMs * .001), 'INVALID_VARIANT', 422, '完整播放版本时长与原文件不一致');
      assert(metadata.kind === 'video' ? item.mime === 'video/mp4' && item.width && item.height && item.bytes <= MEDIA_LIMITS.videoBytes : metadata.kind === 'audio' && item.mime === 'audio/mp4' && item.bytes <= MEDIA_LIMITS.audioBytes && item.width === undefined && item.height === undefined, 'INVALID_VARIANT', 422, '播放版本格式与媒体类型不符');
    } else {
      assert(metadata.kind === 'file' && item.mime === metadata.detectedMime && item.bytes <= MEDIA_LIMITS.fileBytes && item.width === undefined && item.height === undefined && item.durationMs === undefined, 'INVALID_VARIANT', 422, '文件下载版本与已验证原文件不符');
      assert(item.sha256 === metadata.sha256 && item.bytes === metadata.bytes, 'INVALID_VARIANT', 422, '下载文件必须与已验证的静态原文件一致');
    }
  }
}

/** Only authenticated private runner routes may call this class. Run binding adds
 * cross-job isolation; it does not replace the route's signed runner identity. */
export class Processing {
  constructor(readonly store: Store, readonly bucket: R2Bucket, readonly now: () => number) {}
  async get(assetId: string, runId: string): Promise<ProcessingJob> { ids(assetId, runId); const job = await this.store.get<ProcessingJob>(`processing/${assetId}`); assertRun(job, runId); return job; }
  async claim(assetId: string, runId: string) {
    ids(assetId, runId);
    const asset = await this.store.get<MediaAsset>(`media/${assetId}`);
    assert(asset, 'NOT_FOUND', 404, '媒体不存在');
    const original = await this.bucket.head(asset.originalKey);
    assert(original && original.size === asset.originalBytes, 'ORIGINAL_MISMATCH', 409, '私密原文件不存在或大小不一致');
    const job = await this.store.transaction(async tx => {
      const current = await tx.get<ProcessingJob>(`processing/${assetId}`), latest = await tx.get<MediaAsset>(`media/${assetId}`);
      if (current) { assertRun(current, runId); return current; }
      assert(latest?.status === 'processing', 'MEDIA_STATE_CONFLICT', 409, '该媒体当前不能开始处理');
      const created: ProcessingJob = { assetId, runId, state: 'claimed', originalVersion: original.version, originalEtag: original.etag, reservedBytes: 0, variants: [], createdAt: this.now(), updatedAt: this.now() };
      tx.put(`processing/${assetId}`, created); return created;
    });
    return { ...this.publicJob(job), metadata: uploadDeclaration(asset), sourceUrl: `/api/v1/internal/processing/${assetId}/source` };
  }
  async source(assetId: string, runId: string, request: Request): Promise<Response> {
    const job = await this.get(assetId, runId), asset = await this.store.get<MediaAsset>(`media/${assetId}`);
    assert(asset && ['claimed', 'planned'].includes(job.state), 'MEDIA_STATE_CONFLICT', 409, '任务已结束');
    assert(request.method === 'GET' || request.method === 'HEAD', 'METHOD_NOT_ALLOWED', 405, '私密原文件仅允许读取');
    const object = await this.bucket.get(asset.originalKey, { onlyIf: { etagMatches: job.originalEtag } });
    assert(object && 'body' in object && object.version === job.originalVersion && object.size === asset.originalBytes, 'ORIGINAL_MISMATCH', 409, '私密原文件在处理期间发生变化');
    const headers = { 'content-type': 'application/octet-stream', 'content-length': String(object.size), 'cache-control': 'private, no-store', 'content-disposition': 'attachment; filename="source.upload"', 'x-content-type-options': 'nosniff' };
    if (request.method === 'HEAD') { await object.body.cancel(); return new Response(null, { headers }); }
    return new Response(object.body, { headers });
  }
  async plan(assetId: string, runId: string, input: unknown) {
    ids(assetId, runId);
    const plan = ProcessingPlanSchema.parse(input); plan.variants.sort((a, b) => a.role.localeCompare(b.role)); checkVariants(plan.metadata, plan.variants);
    const planHash = await sha256(JSON.stringify(plan)), bytes = plan.variants.reduce((sum, item) => sum + item.bytes, 0);
    await this.store.transaction(async tx => {
      const job = await tx.get<ProcessingJob>(`processing/${assetId}`), asset = await tx.get<MediaAsset>(`media/${assetId}`), quota = await tx.get<Quota>('system/media_quota') || freshQuota();
      assertRun(job, runId);
      if (job.planHash) { assert(job.planHash === planHash && job.state !== 'failed', 'PLAN_CONFLICT', 409, '同一个处理任务不能修改已预留的输出计划'); return; }
      assert(job.state === 'claimed' && asset?.status === 'processing', 'MEDIA_STATE_CONFLICT', 409, '媒体处理状态已改变');
      const metadata = plan.metadata;
      assert(metadata.kind === asset.kind && metadata.bytes === asset.originalBytes && metadata.detectedMime === asset.expectedMime && (!asset.expectedSha256 || metadata.sha256 === asset.expectedSha256), 'DETECTED_METADATA_MISMATCH', 422, '实际检测结果与上传声明不一致');
      assert(canReserveMediaBytes(quota.usedBytes, quota.reservedBytes, bytes), 'MEDIA_QUOTA_EXCEEDED', 409, '原文件与全部衍生版本合计将超过 10 GB');
      const variants: VariantTask[] = plan.variants.map(item => ({ ...item, key: `variants/${assetId}/${runId}/${item.role}`, partSize: PART_SIZE, totalParts: Math.ceil(item.bytes / PART_SIZE), state: 'planned', parts: [], leases: {} }));
      tx.put('system/media_quota', { ...quota, reservedBytes: quota.reservedBytes + bytes });
      tx.put(`processing/${assetId}`, { ...job, state: 'planned', metadata, planHash, reservedBytes: bytes, variants, updatedAt: this.now() });
    });
    for (const item of plan.variants) await this.initializeVariant(assetId, runId, item.role);
    return this.publicJob(await this.get(assetId, runId));
  }
  private async initializeVariant(assetId: string, runId: string, role: Role): Promise<void> {
    const token = crypto.randomUUID();
    const task = await this.store.transaction(async tx => {
      const job = await tx.get<ProcessingJob>(`processing/${assetId}`); assertRun(job, runId); const task = taskFor(job, role);
      if (task.r2UploadId) return null;
      assert(job.state === 'planned', 'MEDIA_STATE_CONFLICT', 409, '任务已结束');
      assert(!task.initializing || !active(task.initializing, this.now()), 'VARIANT_BUSY', 409, '衍生上传正在初始化');
      tx.put(`processing/${assetId}`, replaceTask(job, { ...task, initializing: { token, expiresAt: this.now() + 120_000 } }, this.now())); return task;
    });
    if (!task) return;
    try {
      const multipart = await this.bucket.createMultipartUpload(task.key, { httpMetadata: { contentType: task.mime, ...(task.role === 'download' ? { contentDisposition: 'attachment' } : {}) }, customMetadata: { sha256: task.sha256, assetId, runId, role } });
      await this.store.transaction(async tx => {
        const job = await tx.get<ProcessingJob>(`processing/${assetId}`); assertRun(job, runId); const current = taskFor(job, role);
        assert(job.state === 'planned' && current.initializing?.token === token, 'VARIANT_STATE_CONFLICT', 409, '初始化状态已改变');
        const { initializing: _lease, ...rest } = current;
        tx.put(`processing/${assetId}`, replaceTask(job, { ...rest, state: 'uploading', r2UploadId: multipart.uploadId }, this.now()));
      });
    } catch (error) {
      await this.store.transaction(async tx => { const job = await tx.get<ProcessingJob>(`processing/${assetId}`); assertRun(job, runId); const task = taskFor(job, role); if (task.initializing?.token === token) { const { initializing: _lease, ...rest } = task; tx.put(`processing/${assetId}`, replaceTask(job, rest, this.now())); } });
      // An unacknowledged R2 multipart is retained for reconciliation; quota stays reserved.
      throw error;
    }
  }
  async part(assetId: string, runId: string, roleInput: string, partNumber: number, request: Request): Promise<ProcessingPart> {
    ids(assetId, runId); const role = MediaVariantRoleSchema.parse(roleInput), token = crypto.randomUUID();
    const task = await this.store.transaction(async tx => {
      const job = await tx.get<ProcessingJob>(`processing/${assetId}`); assertRun(job, runId); const task = taskFor(job, role);
      assert(job.state === 'planned' && task.state === 'uploading' && task.r2UploadId, 'VARIANT_STATE_CONFLICT', 409, '衍生上传已结束');
      assert(Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= task.totalParts, 'INVALID_PART', 422, '分片编号无效');
      const live = Object.fromEntries(Object.entries(task.leases).filter(([, lease]) => active(lease, this.now())));
      assert(!live[partNumber], 'PART_BUSY', 409, '分片正在上传，请稍后重试');
      const activeCount = job.variants.reduce((count, variant) => count + Object.values(variant.leases).filter(lease => active(lease, this.now())).length, 0);
      assert(activeCount < 2, 'PROCESSING_CONCURRENCY_LIMIT', 429, '每个处理任务最多同时上传两个分片');
      tx.put(`processing/${assetId}`, replaceTask(job, { ...task, leases: { ...live, [partNumber]: { token, expiresAt: this.now() + 120_000 } } }, this.now())); return task;
    });
    try {
      const expected = Math.min(PART_SIZE, task.bytes - (partNumber - 1) * PART_SIZE), length = request.headers.get('content-length');
      assert(!length || Number(length) === expected, 'PART_SIZE_MISMATCH', 422, '分片声明大小不一致');
      const reader = request.body?.getReader(); assert(reader, 'EMPTY_PART', 400, '分片为空');
      const data = new Uint8Array(expected); let count = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; assert(count + next.value.byteLength <= expected, 'PART_SIZE_MISMATCH', 413, '分片超过允许大小'); data.set(next.value, count); count += next.value.byteLength; } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      assert(count === expected, 'PART_SIZE_MISMATCH', 422, '分片未完整上传');
      // This buffer is already owned and bounded; avoid an extra 5 MiB JS copy.
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(byte => byte.toString(16).padStart(2, '0')).join(''), previous = task.parts.find(item => item.partNumber === partNumber);
      assert(digest === task.partSha256[partNumber - 1], 'PART_HASH_MISMATCH', 422, '实际分片 SHA-256 与受控执行器计划不一致');
      if (previous) assert(previous.sha256 === digest, 'PART_CONFLICT', 409, '已确认分片不可被不同内容覆盖');
      const uploaded = previous || await this.bucket.resumeMultipartUpload(task.key, task.r2UploadId!).uploadPart(partNumber, data);
      const part: ProcessingPart = { partNumber, etag: uploaded.etag, bytes: count, sha256: digest };
      await this.store.transaction(async tx => {
        const job = await tx.get<ProcessingJob>(`processing/${assetId}`); assertRun(job, runId); const current = taskFor(job, role);
        assert(job.state === 'planned' && current.state === 'uploading' && current.leases[partNumber]?.token === token, 'VARIANT_STATE_CONFLICT', 409, '分片租约已改变');
        const leases = { ...current.leases }; delete leases[partNumber];
        tx.put(`processing/${assetId}`, replaceTask(job, { ...current, leases, parts: [...current.parts.filter(item => item.partNumber !== partNumber), part].sort((a, b) => a.partNumber - b.partNumber) }, this.now()));
      }); return part;
    } catch (error) {
      await this.store.transaction(async tx => { const job = await tx.get<ProcessingJob>(`processing/${assetId}`); assertRun(job, runId); const current = taskFor(job, role); if (current.leases[partNumber]?.token === token) { const leases = { ...current.leases }; delete leases[partNumber]; tx.put(`processing/${assetId}`, replaceTask(job, { ...current, leases }, this.now())); } });
      throw error;
    }
  }
  async completeVariant(assetId: string, runId: string, roleInput: string) {
    ids(assetId, runId); const role = MediaVariantRoleSchema.parse(roleInput);
    const task = await this.store.transaction(async tx => {
      const job = await tx.get<ProcessingJob>(`processing/${assetId}`); assertRun(job, runId); const task = taskFor(job, role);
      if (task.state === 'complete') return task;
      assert(job.state === 'planned' && ['uploading', 'completing'].includes(task.state) && task.r2UploadId, 'VARIANT_STATE_CONFLICT', 409, '衍生文件状态不允许合并');
      assert(task.parts.length === task.totalParts && task.parts.every((item, index) => item.partNumber === index + 1 && item.sha256 === task.partSha256[index] && item.bytes === Math.min(PART_SIZE, task.bytes - index * PART_SIZE)) && Object.keys(task.leases).length === 0, 'VARIANT_INCOMPLETE', 409, '仍有衍生分片尚未完成或未通过校验');
      tx.put(`processing/${assetId}`, replaceTask(job, { ...task, state: 'completing' }, this.now())); return task;
    });
    if (task.state === 'complete') return this.publicVariant(task);
    let head = await this.bucket.head(task.key);
    if (!head) {
      // The live R2 completion response can omit custom metadata. Verify a fresh
      // HEAD of the persisted object, including when the completion reply is lost.
      try { await this.bucket.resumeMultipartUpload(task.key, task.r2UploadId!).complete(task.parts.map(({ partNumber, etag }) => ({ partNumber, etag }))); }
      catch (error) { head = await this.bucket.head(task.key); if (!head) throw error; }
      head ||= await this.bucket.head(task.key);
    }
    assert(head, 'VARIANT_STATE_CONFLICT', 409, '合并后的衍生对象尚不可读取，请重试');
    assert(head.size === task.bytes && head.customMetadata?.sha256 === task.sha256, 'VARIANT_SIZE_MISMATCH', 422, '合并后的衍生对象与计划不一致');
    assert(head.etag === task.multipartEtag && head.customMetadata?.assetId === assetId && head.customMetadata?.runId === runId && head.customMetadata?.role === role, 'VARIANT_ETAG_MISMATCH', 409, 'R2 对象未按已验证分片顺序完成');
    // Workers Free must not re-read/hash a complete 512 MB object here. Every
    // bounded request has already checked its actual part SHA against the fixed
    // authenticated runner plan. R2 assembles exactly those server-held ETags in
    // order. The whole-file SHA is trusted runner metadata, not a Worker rehash.
    const verified = { proof: 'verified-parts-r2-order' as const, bytes: head.size, version: head.version, etag: head.etag };
    return this.store.transaction(async tx => {
      const job = await tx.get<ProcessingJob>(`processing/${assetId}`); assertRun(job, runId); const current = taskFor(job, role);
      if (current.state === 'complete') return this.publicVariant(current);
      assert(job.state === 'planned' && current.state === 'completing', 'VARIANT_STATE_CONFLICT', 409, '验证期间任务状态发生变化');
      const done: VariantTask = { ...current, state: 'complete', verified }; tx.put(`processing/${assetId}`, replaceTask(job, done, this.now())); return this.publicVariant(done);
    });
  }
  async finish(assetId: string, runId: string): Promise<MediaAsset> {
    const job = await this.get(assetId, runId);
    assert(job.state === 'planned' || job.state === 'ready', 'MEDIA_STATE_CONFLICT', 409, '任务未完成');
    assert(job.metadata && job.variants.length && job.variants.every(task => task.state === 'complete' && task.verified), 'PROCESSING_INCOMPLETE', 409, '全部衍生文件验证完成后才能准备发布');
    for (const task of job.variants) {
      const head = await this.bucket.head(task.key), verified = task.verified!;
      assert(head && head.size === verified.bytes && head.version === verified.version && head.etag === verified.etag && head.customMetadata?.sha256 === task.sha256, 'VARIANT_STATE_CONFLICT', 409, '已验证的衍生文件不存在或发生变化');
    }
    return this.store.transaction(async tx => {
      const current = await tx.get<ProcessingJob>(`processing/${assetId}`), asset = await tx.get<MediaAsset>(`media/${assetId}`), quota = await tx.get<Quota>('system/media_quota') || freshQuota();
      assertRun(current, runId); assert(asset, 'NOT_FOUND', 404, '媒体不存在');
      if (current.state === 'ready') { assert(asset.status === 'ready', 'MEDIA_STATE_CONFLICT', 409, '媒体完成状态不一致'); return asset; }
      assert(current.state === 'planned' && asset.status === 'processing' && current.planHash === job.planHash && current.metadata, 'MEDIA_STATE_CONFLICT', 409, '媒体状态已改变');
      assert(quota.reservedBytes >= current.reservedBytes, 'QUOTA_STATE_CONFLICT', 409, '容量预留账目需要核对');
      const variants: MediaAsset['variants'] = current.variants.map(task => ({ ...ProcessingVariantSchema.parse({ role: task.role, mime: task.mime, bytes: task.bytes, sha256: task.sha256, ...(task.width ? { width: task.width } : {}), ...(task.height ? { height: task.height } : {}), ...(task.durationMs ? { durationMs: task.durationMs } : {}) }), key: task.key, url: `/api/v1/media/${assetId}/${task.role}` }));
      const ready: MediaAsset = { ...asset, metadata: current.metadata, variants, status: 'ready', updatedAt: new Date(this.now()).toISOString() };
      tx.put(`media/${assetId}`, ready); tx.put(`processing/${assetId}`, { ...current, state: 'ready', reservedBytes: 0, updatedAt: this.now() });
      tx.put('system/media_quota', { ...quota, reservedBytes: quota.reservedBytes - current.reservedBytes, usedBytes: quota.usedBytes + current.reservedBytes }); return ready;
    });
  }
  /** Retain all reserved bytes until an explicit reconciler confirms R2 cleanup. */
  async fail(assetId: string, runId: string, error: { code: string; message: string }): Promise<void> {
    ids(assetId, runId); const safe = z.object({ code: z.string().regex(/^[A-Z0-9_]{1,80}$/), message: z.string().max(500) }).strict().parse(error);
    await this.store.transaction(async tx => {
      const job = await tx.get<ProcessingJob>(`processing/${assetId}`), asset = await tx.get<MediaAsset>(`media/${assetId}`); assertRun(job, runId); assert(asset && job.state !== 'ready', 'MEDIA_STATE_CONFLICT', 409, '已完成媒体不能标记处理失败');
      tx.put(`processing/${assetId}`, { ...job, state: 'failed', error: safe, updatedAt: this.now() }); tx.put(`media/${assetId}`, { ...asset, status: 'failed', error: safe, updatedAt: new Date(this.now()).toISOString() });
    });
  }
  private publicVariant(task: VariantTask) { const { role, mime, bytes, sha256, width, height, durationMs, partSize, partSha256, multipartEtag, totalParts, state, parts } = task; return { role, mime, bytes, sha256, ...(width ? { width } : {}), ...(height ? { height } : {}), ...(durationMs ? { durationMs } : {}), partSize, partSha256, multipartEtag, totalParts, state, parts }; }
  publicJob(job: ProcessingJob) { return { assetId: job.assetId, runId: job.runId, state: job.state, reservedBytes: job.reservedBytes, variants: job.variants.map(task => this.publicVariant(task)) }; }
}
