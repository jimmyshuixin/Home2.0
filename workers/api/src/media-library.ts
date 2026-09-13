import { z } from 'zod';
import { IdSchema, MEDIA_LIMITS, plainText, Sha256Schema } from '@xvyin/contracts';
import type { MediaAsset, Quota } from './media';
import type { ProcessingJob } from './processing';
import type { DraftRecord, Revision } from './records';
import type { ReleaseJob } from './releases';
import type { Store } from './store/types';
import { mediaCursor, mediaQueryOptions, type MediaQueryOptions } from './store/media-query';
import { MEDIA_FENCE_KEY, referencedMedia, type MediaFence } from './media-lifecycle';
import { assert } from './errors';
import { sha256 } from './security';

export const MediaListInputSchema = z.object({ kind: z.enum(['image', 'audio', 'video', 'file']).optional(), status: z.enum(['ready', 'processing', 'failed']).optional(), category: plainText(40).optional(), q: plainText(100).default(''), sort: z.enum(['created', 'name', 'size']).default('created'), direction: z.enum(['asc', 'desc']).default('desc'), lifecycle: z.enum(['active', 'trash']).default('active'), limit: z.number().int().min(1).max(24).default(24), cursor: z.string().max(8192).optional() }).strict();
export type MediaListInput = z.input<typeof MediaListInputSchema>;
export type ManagedMedia = MediaAsset & { version: number; category: string; lifecycle: 'active' | 'trash' | 'purging' | 'deleted'; totalBytes: number };
export interface CatalogState { ready: boolean; processed: number; cursor: string | null; version: number }
export interface MediaListResult { items: ManagedMedia[]; nextCursor: string | null; scanned: number; catalogReady: boolean }
export interface MediaReference { kind: 'draft' | 'settings' | 'revision' | 'release'; collection: string; id: string; title: string }
export interface PurgeJob {
  id: string; assetId: string; authorUid: string; status: 'checking' | 'blocked' | 'ready' | 'deleting' | 'deleted' | 'cancelled' | 'expired';
  expectedVersion: number; phase: number; cursor: string | null; processed: number; references: MediaReference[];
  keys: string[]; completedKeys: number; bytes: number; expiresAt: number; createdAt: string; updatedAt: string;
}
const SCAN_COLLECTIONS = ['active_release', 'creations', 'albums', 'fitness', 'playlists', 'settings', 'revisions', 'releases'] as const;
const versionInput = z.object({ expectedVersion: z.number().int().positive() }).strict();
const categoryInput = versionInput.extend({ category: plainText(40) });
const initialCatalog = (): CatalogState => ({ ready: false, processed: 0, cursor: null, version: 0 });
function managed(asset: MediaAsset): ManagedMedia { return { ...asset, version: asset.version || 1, category: asset.category || '', lifecycle: asset.lifecycle || 'active', totalBytes: asset.originalBytes + asset.variants.reduce((sum, variant) => sum + variant.bytes, 0) }; }
function encodeCursor(value: unknown): string { return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, ''); }
function decodeCursor(cursor: string): unknown { try { assert(/^[A-Za-z0-9_-]{1,8192}$/u.test(cursor), 'INVALID_CURSOR', 422, '媒体分页位置无效'); return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(cursor.replace(/-/gu, '+').replace(/_/gu, '/')), c => c.charCodeAt(0)))); } catch { assert(false, 'INVALID_CURSOR', 422, '媒体分页位置无效，请刷新列表'); } }
function referenceTitle(value: unknown): string { const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}; return typeof item.title === 'string' && item.title || typeof item.name === 'string' && item.name || '未命名内容'; }
function sameVersion(asset: MediaAsset | null, expectedVersion: number): asserts asset is MediaAsset { assert(asset, 'NOT_FOUND', 404, '媒体不存在'); assert((asset.version || 1) === expectedVersion, 'VERSION_CONFLICT', 409, '媒体资料已改变，请刷新后重试'); }
function activeFence(fence: MediaFence | null, now: number): boolean { return Boolean(fence?.taskId && (fence.expiresAt || 0) > now); }
function checkOwnedFence(fence: MediaFence | null, job: PurgeJob, now: number): void { assert(job.expiresAt > now && activeFence(fence, now) && fence?.taskId === job.id, 'PURGE_CHECK_EXPIRED', 409, '删除检查已过期或被取消，请重新检查后再确认'); }

/** The catalog is a private projection, updated atomically by every media put.
 * Old data is backfilled five records at a time; reads do not silently omit it. */
export class MediaLibrary {
  constructor(readonly store: Store, readonly bucket: R2Bucket, readonly now: () => number) {}
  async catalogStatus(): Promise<CatalogState> { return await this.store.get<CatalogState>('system/media_catalog') || initialCatalog(); }
  async advanceCatalog(): Promise<CatalogState> {
    const state = await this.catalogStatus(); if (state.ready) return state;
    const page = await this.store.list<MediaAsset>('media', { limit: 5, ...(state.cursor ? { cursor: state.cursor } : {}) });
    return this.store.transaction(async tx => {
      const current = await tx.get<CatalogState>('system/media_catalog') || initialCatalog(); if (current.version !== state.version || current.ready) return current;
      const assets = await Promise.all(page.items.map(row => tx.get<MediaAsset>(`media/${row.id}`)));
      for (const asset of assets) if (asset) {
        const projected = managed(asset); if (projected.lifecycle === 'deleted') tx.delete(`media_catalog/${asset.id}`); else tx.put(`media_catalog/${asset.id}`, projected);
        if (asset.status === 'ready' && projected.lifecycle === 'active' && asset.metadata?.sha256) tx.put(`media_hashes/${asset.metadata.sha256}`, { assetId: asset.id, kind: asset.kind, bytes: asset.originalBytes });
      }
      const next = { ready: !page.nextCursor, processed: current.processed + page.items.length, cursor: page.nextCursor, version: current.version + 1 }; tx.put('system/media_catalog', next); return next;
    });
  }
  async list(input: MediaListInput = {}): Promise<MediaListResult> {
    const options = MediaListInputSchema.parse(input), state = await this.catalogStatus();
    if (!state.ready) return { items: [], nextCursor: null, scanned: 0, catalogReady: false };
    assert(this.store.queryMedia, 'MEDIA_QUERY_UNAVAILABLE', 503, '媒体目录查询尚未配置');
    const signature = JSON.stringify({ ...options, cursor: undefined }), query: MediaQueryOptions = { sort: options.sort, direction: options.direction, limit: 48 };
    if (options.cursor) {
      const cursor = z.object({ v: z.literal(1), signature: z.string(), after: z.string().max(4096) }).strict().parse(decodeCursor(options.cursor));
      assert(cursor.signature === signature, 'INVALID_CURSOR', 422, '筛选或排序已改变，请从第一页重新读取'); query.cursor = cursor.after;
      try { mediaQueryOptions(query); } catch { assert(false, 'INVALID_CURSOR', 422, '媒体分页位置无效，请刷新列表'); }
    }
    const page = await this.store.queryMedia<ManagedMedia>(query), items: ManagedMedia[] = []; let scanned = 0, after: string | null = null;
    const needle = options.q.normalize('NFKC').toLowerCase();
    for (const row of page.items) {
      scanned++; after = mediaCursor(query, row.sortValue); const item = row.data;
      if ((item.lifecycle === options.lifecycle || options.lifecycle === 'trash' && item.lifecycle === 'purging') && (!options.kind || item.kind === options.kind) && (!options.status || item.status === options.status) && (options.category === undefined || item.category === options.category) && (!needle || item.originalName.normalize('NFKC').toLowerCase().includes(needle))) items.push(item);
      if (items.length === options.limit) break;
    }
    const hasMore = scanned < page.items.length || Boolean(page.nextCursor);
    return { items, nextCursor: hasMore && after ? encodeCursor({ v: 1, signature, after }) : null, scanned, catalogReady: true };
  }
  async findDuplicate(input: { sha256: string; kind: MediaAsset['kind']; bytes: number }): Promise<MediaAsset | null> {
    const value = z.object({ sha256: Sha256Schema, kind: z.enum(['image', 'audio', 'video', 'file']), bytes: z.number().int().positive().max(MEDIA_LIMITS.videoBytes) }).strict().parse(input);
    const match = await this.store.get<{ assetId: string; kind: string; bytes: number }>(`media_hashes/${value.sha256}`);
    if (!match || match.kind !== value.kind || match.bytes !== value.bytes) return null;
    const asset = await this.store.get<MediaAsset>(`media/${IdSchema.parse(match.assetId)}`);
    return asset?.status === 'ready' && (!asset.lifecycle || asset.lifecycle === 'active') && asset.kind === value.kind && asset.originalBytes === value.bytes && asset.metadata?.sha256 === value.sha256 ? asset : null;
  }
  async update(id: string, input: { expectedVersion: number; category: string }): Promise<ManagedMedia> {
    const values = categoryInput.parse(input); IdSchema.parse(id);
    return this.store.transaction(async tx => {
      const asset = await tx.get<MediaAsset>(`media/${id}`); sameVersion(asset, values.expectedVersion);
      assert(!['purging', 'deleted'].includes(asset.lifecycle || ''), 'MEDIA_DELETED', 409, '媒体正在删除或已删除');
      const next = managed({ ...asset, category: values.category, version: values.expectedVersion + 1, updatedAt: new Date(this.now()).toISOString() }); tx.put(`media/${id}`, next); return next;
    });
  }
  async trash(id: string, input: { expectedVersion: number }, uid: string): Promise<ManagedMedia> { return this.visibility(id, input, uid, 'trash'); }
  async restore(id: string, input: { expectedVersion: number }, uid: string): Promise<ManagedMedia> { return this.visibility(id, input, uid, 'active'); }
  private async visibility(id: string, input: { expectedVersion: number }, uid: string, lifecycle: 'active' | 'trash'): Promise<ManagedMedia> {
    const values = versionInput.parse(input); IdSchema.parse(id);
    return this.store.transaction(async tx => {
      const asset = await tx.get<MediaAsset>(`media/${id}`), fence = await tx.get<MediaFence>(MEDIA_FENCE_KEY); sameVersion(asset, values.expectedVersion);
      assert(asset.status !== 'processing', 'MEDIA_BUSY', 409, '媒体正在处理，请处理结束后再移动');
      assert(!['purging', 'deleted'].includes(asset.lifecycle || '') && !(activeFence(fence, this.now()) && fence?.assetId === id), 'MEDIA_CLEANUP_BUSY', 409, '媒体正在进行删除检查或清理');
      if ((asset.lifecycle || 'active') === lifecycle) return managed(asset);
      const { purgeJobId: _previousJob, ...available } = asset;
      const at = new Date(this.now()).toISOString(), next = managed({ ...available, lifecycle, version: values.expectedVersion + 1, updatedAt: at, ...(lifecycle === 'trash' ? { trashedAt: at } : {}) });
      tx.put(`media/${id}`, next); tx.put(`audit/${crypto.randomUUID()}`, { action: lifecycle === 'trash' ? 'media_trashed' : 'media_restored', assetId: id, uid, at }); return next;
    });
  }
  async startPurge(id: string, input: { expectedVersion: number }, uid: string, idempotencyKey: string): Promise<PurgeJob> {
    IdSchema.parse(id); const values = versionInput.parse(input); z.string().uuid().parse(idempotencyKey);
    const requestId = await sha256(`purge:${uid}:${id}:${idempotencyKey}`), at = new Date(this.now()).toISOString();
    return this.store.transaction(async tx => {
      const receipt = await tx.get<{ jobId: string; version: number }>(`media_purge_requests/${requestId}`), asset = await tx.get<MediaAsset>(`media/${id}`), fence = await tx.get<MediaFence>(MEDIA_FENCE_KEY), processing = await tx.get<ProcessingJob>(`processing/${id}`);
      if (receipt) { assert(receipt.version === values.expectedVersion, 'IDEMPOTENCY_CONFLICT', 409, '同一删除请求不能更改媒体版本'); const existing = await tx.get<PurgeJob>(`media_purge_jobs/${receipt.jobId}`); assert(existing, 'PURGE_STATE_CONFLICT', 409, '删除任务需要核对'); return existing; }
      sameVersion(asset, values.expectedVersion); assert(asset.lifecycle === 'trash', 'MEDIA_NOT_TRASHED', 409, '请先将媒体移入回收站，再检查永久删除');
      assert(asset.status !== 'processing', 'MEDIA_BUSY', 409, '媒体正在处理，暂时不能永久删除');
      assert(!processing || ['ready', 'failed'].includes(processing.state) && processing.reservedBytes === 0 && processing.variants.every(task => task.state === 'complete' && !task.initializing && !Object.keys(task.leases).length), 'MEDIA_CLEANUP_REQUIRED', 409, '此媒体仍有未释放的处理任务或容量预留，需要先完成处理清理；可继续保留在回收站。');
      assert(!activeFence(fence, this.now()), 'MEDIA_CLEANUP_BUSY', 409, '另一个媒体正在进行删除检查，请先完成或取消它');
      const keys = [...new Set([asset.originalKey, ...asset.variants.map(variant => variant.key)])];
      assert(keys.length <= 21 && keys.every(key => key === `originals/${id}/source` || key.startsWith(`variants/${id}/`) && !key.includes('..')), 'MEDIA_KEY_INVALID', 409, '媒体对象路径需要核对');
      const job: PurgeJob = { id: crypto.randomUUID(), assetId: id, authorUid: uid, status: 'checking', expectedVersion: values.expectedVersion, phase: 0, cursor: null, processed: 0, references: [], keys, completedKeys: 0, bytes: managed(asset).totalBytes, expiresAt: this.now() + 15 * 60_000, createdAt: at, updatedAt: at };
      assert(Number.isSafeInteger(job.bytes) && job.bytes >= 0, 'QUOTA_STATE_CONFLICT', 409, '媒体字节账目需要核对');
      tx.put(`media/${id}`, { ...asset, purgeJobId: job.id });
      tx.put(`media_purge_jobs/${job.id}`, job); tx.put(`media_purge_requests/${requestId}`, { jobId: job.id, version: values.expectedVersion }); tx.put(MEDIA_FENCE_KEY, { epoch: (fence?.epoch || 0) + 1, taskId: job.id, assetId: id, expiresAt: job.expiresAt }); return job;
    });
  }
  async getPurge(jobId: string, uid: string): Promise<PurgeJob> {
    IdSchema.parse(jobId); const job = await this.store.get<PurgeJob>(`media_purge_jobs/${jobId}`); assert(job && job.authorUid === uid, 'NOT_FOUND', 404, '删除任务不存在');
    return ['checking', 'ready'].includes(job.status) && job.expiresAt <= this.now() ? { ...job, status: 'expired' } : job;
  }
  async cancelPurge(jobId: string, uid: string): Promise<PurgeJob> {
    const job = await this.getPurge(jobId, uid);
    assert(!['deleting', 'deleted'].includes(job.status), 'PURGE_ALREADY_CONFIRMED', 409, '已确认的物理清理不能撤回，可继续重试完成');
    return this.store.transaction(async tx => {
      const current = await tx.get<PurgeJob>(`media_purge_jobs/${jobId}`), fence = await tx.get<MediaFence>(MEDIA_FENCE_KEY); assert(current && !['deleting', 'deleted'].includes(current.status), 'PURGE_ALREADY_CONFIRMED', 409, '清理已经开始');
      const asset = await tx.get<MediaAsset>(`media/${current.assetId}`);
      if (asset?.purgeJobId === jobId) { const { purgeJobId: _previousJob, ...available } = asset; tx.put(`media/${asset.id}`, available); }
      const next = { ...current, status: 'cancelled' as const, updatedAt: new Date(this.now()).toISOString() }; tx.put(`media_purge_jobs/${jobId}`, next);
      if (fence?.taskId === jobId) tx.put(MEDIA_FENCE_KEY, { epoch: fence.epoch + 1 }); return next;
    });
  }
  async advancePurge(jobId: string, uid: string): Promise<PurgeJob> {
    const job = await this.getPurge(jobId, uid); if (job.status === 'deleting') return this.deleteStep(job);
    if (job.status !== 'checking') return job;
    checkOwnedFence(await this.store.get<MediaFence>(MEDIA_FENCE_KEY), job, this.now());
    const collection = SCAN_COLLECTIONS[job.phase]; assert(collection, 'PURGE_STATE_CONFLICT', 409, '删除检查阶段无效');
    const page = collection === 'active_release' ? await this.activeReferencePage() : await this.store.list<DraftRecord | Revision | ReleaseJob>(collection, { limit: collection === 'releases' ? 1 : 5, ...(job.cursor ? { cursor: job.cursor } : {}) });
    const references: MediaReference[] = [];
    for (const row of page.items) {
      let data: unknown, kind: MediaReference['kind'];
      if (collection === 'releases' || collection === 'active_release') {
        const release = row.data as ReleaseJob; kind = 'release';
        const object = await this.bucket.get(`private-snapshots/${row.id}.json`) || await this.bucket.get(`private-snapshot-sources/${row.id}.json`);
        assert(object && object.size <= 10 * 1024 * 1024, 'RELEASE_REFERENCE_UNAVAILABLE', 409, '历史发布快照暂不可检查，不能确认永久删除'); data = await object.json();
        const snapshot = data as { assets?: { id: string }[] };
        if (snapshot.assets?.some(asset => asset.id === job.assetId) || referencedMedia(data).has(job.assetId)) references.push({ kind, collection, id: row.id, title: `发布版本 ${release.id}（${release.status}）` });
      } else {
        kind = collection === 'settings' ? 'settings' : collection === 'revisions' ? 'revision' : 'draft';
        data = collection === 'revisions' ? (row.data as Revision).data : (row.data as DraftRecord).draft;
        if (referencedMedia(data).has(job.assetId)) references.push({ kind, collection: collection === 'revisions' ? (row.data as Revision).collection : collection, id: row.id, title: referenceTitle(data) });
      }
    }
    return this.store.transaction(async tx => {
      const current = await tx.get<PurgeJob>(`media_purge_jobs/${jobId}`), fence = await tx.get<MediaFence>(MEDIA_FENCE_KEY); assert(current, 'NOT_FOUND', 404, '删除任务不存在');
      if (current.status !== 'checking' || current.phase !== job.phase || current.cursor !== job.cursor) return current;
      checkOwnedFence(fence, current, this.now());
      const asset = references.length ? await tx.get<MediaAsset>(`media/${current.assetId}`) : null;
      const phase = page.nextCursor ? current.phase : current.phase + 1;
      const next: PurgeJob = { ...current, phase, cursor: page.nextCursor, processed: current.processed + page.items.length, references, status: references.length ? 'blocked' : phase === SCAN_COLLECTIONS.length ? 'ready' : 'checking', updatedAt: new Date(this.now()).toISOString() };
      tx.put(`media_purge_jobs/${jobId}`, next);
      if (next.status === 'blocked') {
        if (asset?.purgeJobId === jobId) { const { purgeJobId: _previousJob, ...available } = asset; tx.put(`media/${asset.id}`, available); }
        tx.put(MEDIA_FENCE_KEY, { epoch: (fence?.epoch || 0) + 1 });
      }
      return next;
    });
  }
  private async activeReferencePage(): Promise<{ items: Array<{ id: string; data: { id: string; status: string } }>; nextCursor: null }> {
    const object = await this.bucket.get('active-release.json'); if (!object) return { items: [], nextCursor: null };
    assert(object.size < 4096, 'RELEASE_REFERENCE_UNAVAILABLE', 409, '当前发布指针暂不可检查');
    const active = await object.json<{ releaseId: string }>(), id = IdSchema.parse(active.releaseId);
    return { items: [{ id, data: { id, status: 'active' } }], nextCursor: null };
  }
  async confirmPurge(jobId: string, uid: string): Promise<PurgeJob> {
    const job = await this.getPurge(jobId, uid); if (['deleting', 'deleted'].includes(job.status)) return job;
    assert(job.status === 'ready', 'PURGE_NOT_READY', 409, '请先完成全部引用检查，再确认永久删除');
    return this.store.transaction(async tx => {
      const current = await tx.get<PurgeJob>(`media_purge_jobs/${jobId}`), asset = await tx.get<MediaAsset>(`media/${job.assetId}`), fence = await tx.get<MediaFence>(MEDIA_FENCE_KEY), quota = await tx.get<Quota>('system/media_quota');
      if (current && ['deleting', 'deleted'].includes(current.status)) return current;
      assert(current?.status === 'ready', 'PURGE_NOT_READY', 409, '删除任务状态已改变'); checkOwnedFence(fence, current, this.now()); sameVersion(asset, current.expectedVersion);
      assert(asset.lifecycle === 'trash' && asset.status !== 'processing', 'MEDIA_STATE_CHANGED', 409, '媒体状态已改变');
      assert(quota && Number.isSafeInteger(quota.usedBytes) && quota.usedBytes >= current.bytes, 'QUOTA_STATE_CONFLICT', 409, '容量账目需要核对后才能永久删除');
      const at = new Date(this.now()).toISOString(), next = { ...current, status: 'deleting' as const, updatedAt: at };
      tx.put(`media/${asset.id}`, { ...asset, lifecycle: 'purging', version: current.expectedVersion + 1, updatedAt: at }); tx.put(`media_purge_jobs/${jobId}`, next);
      // The per-asset tombstone now rejects stale editors. Release the global
      // check fence so unrelated editing continues even if R2 cleanup retries.
      tx.put(MEDIA_FENCE_KEY, { epoch: (fence?.epoch || 0) + 1 }); return next;
    });
  }
  private async deleteStep(job: PurgeJob): Promise<PurgeJob> {
    const key = job.keys[job.completedKeys];
    if (key) await this.bucket.delete(key);
    return this.store.transaction(async tx => {
      const current = await tx.get<PurgeJob>(`media_purge_jobs/${job.id}`), asset = await tx.get<MediaAsset>(`media/${job.assetId}`), quota = await tx.get<Quota>('system/media_quota');
      assert(current && asset, 'PURGE_STATE_CONFLICT', 409, '删除记录需要核对'); if (current.status === 'deleted') return current;
      assert(current.status === 'deleting' && asset.lifecycle === 'purging', 'PURGE_STATE_CONFLICT', 409, '媒体清理状态已改变');
      if (current.completedKeys !== job.completedKeys) return current;
      const completedKeys = current.completedKeys + (key ? 1 : 0), at = new Date(this.now()).toISOString();
      const next = { ...current, completedKeys, status: completedKeys >= current.keys.length ? 'deleted' as const : 'deleting' as const, updatedAt: at };
      if (next.status === 'deleted') {
        assert(quota && quota.usedBytes >= current.bytes, 'QUOTA_STATE_CONFLICT', 409, '容量账目需要核对，清理任务已保留以供重试');
        tx.put('system/media_quota', { ...quota, usedBytes: quota.usedBytes - current.bytes });
        tx.put(`media/${asset.id}`, { ...asset, lifecycle: 'deleted', version: (asset.version || 1) + 1, deletedAt: at, updatedAt: at });
        tx.put(`audit/${crypto.randomUUID()}`, { action: 'media_purged', assetId: asset.id, uid: current.authorUid, bytes: current.bytes, taskId: job.id, at });
      }
      tx.put(`media_purge_jobs/${job.id}`, next); return next;
    });
  }
}
