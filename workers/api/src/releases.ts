import { z } from 'zod';
import { SiteSettingsSchema, FitnessSettingsDraftSchema, PublishableCreationSchema, AlbumDraftSchema, PlaylistDraftSchema, FitnessEntryDraftSchema, IdSchema, Sha256Schema, PublicMediaAssetSchema, deriveFormats, fitnessDayCount, type SiteSettings, type FitnessSettingsDraft, type CreationDraft, type AlbumDraft, type FitnessEntryDraft, type PlaylistDraft, type PublicMediaAsset } from '@xvyin/contracts';
import type { Store } from './store/types';
import type { DraftRecord } from './records';
import type { MediaAsset } from './media';
import { assert } from './errors';
import { sha256 } from './security';
export type Published<T> = T & { id: string; revisionId: string; publishedAt: string };
export interface Snapshot {
  schemaVersion: 1; releaseId: string; settings: SiteSettings;
  creations: Array<Published<CreationDraft> & { formats: string[] }>; albums: Array<Published<AlbumDraft>>;
  fitness: { settings: FitnessSettingsDraft; entries: Array<Published<FitnessEntryDraft>> };
  playlists: Array<Published<PlaylistDraft>>; assets: PublicMediaAsset[]; routeAliases: Record<string, string>;
}
export const ReleaseChangeSchema = z.object({ collection: z.enum(['creations', 'albums', 'fitness', 'playlists', 'settings']), id: IdSchema, version: z.number().int().positive(), action: z.enum(['publish', 'hide']) }).strict();
export const ReleaseInputSchema = z.object({ changes: z.array(ReleaseChangeSchema).min(1).max(50), expectedReleaseId: IdSchema.nullable() }).strict();
export type ReleaseChange = z.infer<typeof ReleaseChangeSchema>;
export interface ActiveRelease { releaseId: string; manifestSha256: string; activatedAt: string; schemaVersion: 1; codeSha: string; runId: string }
export interface BuildFile { path: string; key: string; sha256: string; bytes: number; contentType: string }
export interface ReleaseManifest { releaseId: string; schemaVersion: 1; files: BuildFile[]; assets: Record<string, { key: string; mime: string; bytes: number; sha256: string }> }
export interface ManifestPreparation { pending: true; phase: 'assets'; processed: number; total: number }
const RELEASE_ASSET_BATCH_SIZE = 100;
interface SnapshotPreparationState { sourceSha256: string; processed: number; assets: PublicMediaAsset[] }
interface ManifestPreparationState { inputSha256: string; snapshotSha256: string; processed: number; assets: ReleaseManifest['assets'] }
export interface ReleaseJob {
  id: string; status: 'queued' | 'building' | 'ready' | 'activating' | 'live' | 'superseded' | 'failed' | 'reconciling';
  changes: ReleaseChange[]; previousReleaseId: string | null; previousEtag: string | null; createdAt: string; updatedAt: string;
  authorUid: string; codeSha: string; runId: string | null; manifestSha256: string | null; snapshotSha256: string;
  selectedRevisionIds: Record<string, string>; error?: { code: string; message: string };
  /** false means snapshotSha256 hashes the immutable source, not an SSG-ready snapshot yet. */
  snapshotPrepared?: boolean;
  preparedAssetCount?: number;
  assetCount?: number;
  verifiedFileCount?: number;
  verifiedIndexCount?: number;
  indexCount?: number;
  reconciledRecords?: number;
}
export const BuildManifestInputSchema = z.object({ files: z.array(z.object({
  path: z.string().regex(/^\/[A-Za-z0-9_\-./%]+$/u).max(500).refine(v => !v.includes('..') && !v.includes('//') && !/%(?:2f|5c|2e|00)/iu.test(v)),
  sha256: Sha256Schema, bytes: z.number().int().positive().max(25 * 1024 * 1024),
  contentType: z.enum(['text/html; charset=utf-8', 'text/css; charset=utf-8', 'application/javascript; charset=utf-8', 'application/json; charset=utf-8', 'text/plain; charset=utf-8', 'application/xml; charset=utf-8', 'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon', 'font/woff', 'font/woff2', 'font/ttf', 'audio/mpeg', 'application/octet-stream']),
}).strict()).min(1).max(5000) }).strict();
export function emptySnapshot(releaseId: string): Snapshot {
  return { schemaVersion: 1, releaseId, settings: SiteSettingsSchema.parse({}), creations: [], albums: [], fitness: { settings: FitnessSettingsDraftSchema.parse({}), entries: [] }, playlists: [], assets: [], routeAliases: {} };
}
export function collectAssetIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (Array.isArray(value)) { value.forEach(item => collectAssetIds(item, ids)); return ids; }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (key.endsWith('AssetId') || key === 'assetId') { if (typeof item === 'string') ids.add(item); }
    else if (key !== 'assets') collectAssetIds(item, ids);
  }
  return ids;
}
function publicAsset(asset: MediaAsset | null | undefined, id: string): PublicMediaAsset {
  assert(asset?.id === id && asset.status === 'ready' && asset.variants.length, 'MEDIA_NOT_READY', 422, '引用的媒体尚未处理完成');
  return PublicMediaAssetSchema.parse({ id: asset.id, kind: asset.kind, variants: asset.variants.map(({ key: _key, sha256: _sha, ...variant }) => ({ ...variant, url: `/api/v1/media/${asset.id}/${variant.role}` })) });
}
async function immutableJson(bucket: R2Bucket, key: string, value: unknown, maxBytes: number): Promise<string> {
  const serialized = JSON.stringify(value);
  assert(new TextEncoder().encode(serialized).length <= maxBytes, 'RELEASE_TOO_LARGE', 422, '发布数据超过当前文档大小上限');
  const written = await bucket.put(key, serialized, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
  if (!written) {
    const previous = await bucket.get(key);
    assert(previous && previous.size <= maxBytes && await previous.text() === serialized, 'MANIFEST_CONFLICT', 409, '已冻结的发布数据不同');
  }
  return serialized;
}
export class Releases {
  constructor(readonly store: Store, readonly bucket: R2Bucket, readonly now: () => number, readonly codeSha: string) {}
  async active(): Promise<{ value: ActiveRelease; etag: string } | null> {
    const object = await this.bucket.get('active-release.json'); if (!object) return null;
    assert(object.size < 4096, 'RELEASE_INVALID', 503, '发布索引无效');
    const value = await object.json<ActiveRelease>();
    assert(value.schemaVersion === 1 && /^[A-Za-z0-9_-]+$/u.test(value.releaseId), 'RELEASE_INVALID', 503, '发布版本暂不兼容');
    return { value, etag: object.etag };
  }
  async snapshot(id: string): Promise<Snapshot> {
    IdSchema.parse(id); const object = await this.bucket.get(`private-snapshots/${id}.json`);
    assert(object && object.size <= 10 * 1024 * 1024, 'RELEASE_NOT_FOUND', 404, '内容版本不存在');
    return object.json<Snapshot>();
  }
  async manifest(id: string): Promise<ReleaseManifest> {
    IdSchema.parse(id); const object = await this.bucket.get(`releases/${id}/manifest.json`);
    assert(object && object.size <= 4 * 1024 * 1024, 'RELEASE_NOT_FOUND', 404, '发布清单不存在');
    return object.json<ReleaseManifest>();
  }
  async create(input: unknown, uid: string): Promise<ReleaseJob> {
    const { changes, expectedReleaseId } = ReleaseInputSchema.parse(input), active = await this.active();
    assert((active?.value.releaseId || null) === expectedReleaseId, 'RELEASE_CONFLICT', 409, '线上版本已改变，请刷新后再发布');
    assert(/^[a-f0-9]{40}$/u.test(this.codeSha), 'BUILD_NOT_CONFIGURED', 503, '发布代码版本尚未配置');
    assert(new Set(changes.map(change => `${change.collection}/${change.id}`)).size === changes.length, 'DUPLICATE_CHANGE', 422, '同一内容不能重复出现在发布清单');
    const id = crypto.randomUUID(), at = new Date(this.now()).toISOString();
    const snapshot = active ? await this.snapshot(active.value.releaseId) : emptySnapshot(id); snapshot.releaseId = id;
    const selectedRevisionIds: Record<string, string> = {};
    const selected = await this.store.getMany<DraftRecord>(changes.map(change => `${change.collection}/${change.id}`));
    for (const [index, change] of changes.entries()) {
      const key = `${change.collection}/${change.id}`, record = selected[index];
      assert(record && record.version === change.version, 'VERSION_CONFLICT', 409, '草稿版本已改变，请刷新后生成预览');
      selectedRevisionIds[key] = record.draftRevisionId;
      if (change.collection === 'settings') {
        assert(change.action === 'publish', 'INVALID_CHANGE', 422, '设置通过保存空值或开关后发布');
        if (change.id === 'site') snapshot.settings = SiteSettingsSchema.parse(record.draft);
        else { assert(change.id === 'fitness', 'INVALID_CHANGE', 422, '设置项不存在'); snapshot.fitness.settings = FitnessSettingsDraftSchema.parse(record.draft); fitnessDayCount(snapshot.fitness.settings.startDate, this.now()); }
        continue;
      }
      const common = { id: change.id, revisionId: record.draftRevisionId, publishedAt: at };
      if (change.collection === 'creations') {
        const old = snapshot.creations.find(item => item.id === change.id); snapshot.creations = snapshot.creations.filter(item => item.id !== change.id);
        if (change.action === 'publish') { const draft = PublishableCreationSchema.parse(record.draft); snapshot.creations.push({ ...draft, ...common, formats: deriveFormats(draft) }); if (old && old.slug !== draft.slug) snapshot.routeAliases[`/creations/${old.slug}`] = `/creations/${draft.slug}`; }
      } else if (change.collection === 'albums') {
        const old = snapshot.albums.find(item => item.id === change.id); snapshot.albums = snapshot.albums.filter(item => item.id !== change.id);
        if (change.action === 'publish') { const draft = AlbumDraftSchema.parse(record.draft); assert(draft.title && draft.slug, 'PUBLISH_VALIDATION', 422, '摄影集发布前需要标题与地址'); snapshot.albums.push({ ...draft, photos: draft.photos.filter(p => p.status === 'published'), ...common }); if (old && old.slug !== draft.slug) snapshot.routeAliases[`/photography/${old.slug}`] = `/photography/${draft.slug}`; }
      } else if (change.collection === 'fitness') {
        snapshot.fitness.entries = snapshot.fitness.entries.filter(item => item.id !== change.id);
        if (change.action === 'publish') { const draft = FitnessEntryDraftSchema.parse(record.draft); assert(draft.title, 'PUBLISH_VALIDATION', 422, '健身记录发布前需要标题'); snapshot.fitness.entries.push({ ...draft, photos: draft.photos.filter(p => p.status === 'published'), ...common }); }
      } else {
        snapshot.playlists = snapshot.playlists.filter(item => item.id !== change.id);
        if (change.action === 'publish') snapshot.playlists.push({ ...PlaylistDraftSchema.parse(record.draft), ...common });
      }
    }
    for (const entries of [snapshot.creations, snapshot.albums]) assert(new Set(entries.map(item => item.slug)).size === entries.length, 'SLUG_CONFLICT', 409, '公开地址重复，请修改 slug');
    assert(snapshot.playlists.filter(p => p.enabled && p.isDefault).length <= 1, 'DEFAULT_PLAYLIST_CONFLICT', 422, '只能有一个启用的默认歌单');
    const routes = new Set([...snapshot.creations.map(v => `/creations/${v.slug}`), ...snapshot.albums.map(v => `/photography/${v.slug}`)]);
    snapshot.routeAliases = Object.fromEntries(Object.entries(snapshot.routeAliases).filter(([from, to]) => !routes.has(from) && routes.has(to)));
    // Preserve the already loaded published projection; never re-read the full previous snapshot.
    const ids = [...collectAssetIds(snapshot)], wanted = new Set(ids), previousAssets = snapshot.assets;
    const previousIds = new Set(previousAssets.map(asset => asset.id)), freshIds = ids.filter(assetId => !previousIds.has(assetId));
    snapshot.assets = previousAssets.filter(asset => wanted.has(asset.id));
    const batchIds = freshIds.slice(0, RELEASE_ASSET_BATCH_SIZE);
    const assets = await this.store.getMany<MediaAsset>(batchIds.map(assetId => `media/${assetId}`));
    snapshot.assets.push(...batchIds.map((assetId, index) => publicAsset(assets[index], assetId)));
    const snapshotPrepared = freshIds.length === batchIds.length;
    const json = JSON.stringify(snapshot), snapshotSha256 = await sha256(json);
    assert(new TextEncoder().encode(json).length <= 10 * 1024 * 1024, 'SNAPSHOT_TOO_LARGE', 422, '发布快照超过当前上限，请减少单次公开内容');
    await immutableJson(this.bucket, `${snapshotPrepared ? 'private-snapshots' : 'private-snapshot-sources'}/${id}.json`, snapshot, 10 * 1024 * 1024);
    const job: ReleaseJob = { id, status: 'queued', changes, previousReleaseId: active?.value.releaseId || null, previousEtag: active?.etag || null, authorUid: uid, createdAt: at, updatedAt: at, codeSha: this.codeSha, runId: null, manifestSha256: null, snapshotSha256, selectedRevisionIds, snapshotPrepared, preparedAssetCount: snapshot.assets.length, assetCount: ids.length };
    await this.store.transaction(async tx => { await tx.get(`releases/${id}`); tx.put(`releases/${id}`, job); }); return job;
  }
  /** One batch per HTTP request. The selected content is never read again from mutable drafts. */
  async prepareSnapshot(id: string, runId: string): Promise<ReleaseJob> {
    const job = await this.get(id);
    assert(job.status === 'building' && job.runId === runId, 'BUILD_STATE_CONFLICT', 409, '构建任务状态不符');
    if (job.snapshotPrepared !== false) return job;
    const source = await this.bucket.get(`private-snapshot-sources/${id}.json`);
    assert(source && source.size <= 10 * 1024 * 1024, 'RELEASE_NOT_FOUND', 404, '冻结的候选来源不存在');
    const sourceJson = await source.text();
    assert(await sha256(sourceJson) === job.snapshotSha256, 'RELEASE_INTEGRITY', 503, '冻结的候选来源校验失败');
    const snapshot = JSON.parse(sourceJson) as Snapshot, known = new Set(snapshot.assets.map(asset => asset.id));
    const remainingIds = [...collectAssetIds(snapshot)].filter(assetId => !known.has(assetId));
    const key = `private-snapshot-preparation/${id}.json`, current = await this.bucket.get(key);
    assert(!current || current.size <= 10 * 1024 * 1024, 'RELEASE_INVALID', 503, '候选准备进度无效');
    let progress: SnapshotPreparationState = current ? await current.json<SnapshotPreparationState>() : { sourceSha256: job.snapshotSha256, processed: 0, assets: [] };
    const validate = () => assert(progress.sourceSha256 === job.snapshotSha256 && Number.isInteger(progress.processed)
      && progress.processed >= 0 && progress.processed <= remainingIds.length && progress.assets.length === progress.processed
      && progress.assets.every((asset, index) => asset.id === remainingIds[index]), 'RELEASE_INTEGRITY', 503, '候选准备进度与来源不符');
    validate();
    if (progress.processed < remainingIds.length) {
      const batchIds = remainingIds.slice(progress.processed, progress.processed + RELEASE_ASSET_BATCH_SIZE);
      const records = await this.store.getMany<MediaAsset>(batchIds.map(assetId => `media/${assetId}`));
      const next: SnapshotPreparationState = { ...progress, processed: progress.processed + batchIds.length,
        assets: [...progress.assets, ...batchIds.map((assetId, index) => publicAsset(records[index], assetId))] };
      const serialized = JSON.stringify(next);
      assert(new TextEncoder().encode(serialized).length <= 10 * 1024 * 1024, 'RELEASE_TOO_LARGE', 422, '候选资产投影超过文档大小上限');
      const updated = await this.bucket.put(key, serialized, { onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' } });
      if (updated) progress = next;
      else {
        const winner = await this.bucket.get(key);
        assert(winner && winner.size <= 10 * 1024 * 1024, 'RELEASE_INTEGRITY', 503, '候选准备进度需要重试');
        progress = await winner.json<SnapshotPreparationState>(); validate();
      }
    }
    const preparedAssetCount = snapshot.assets.length + progress.processed, complete = progress.processed === remainingIds.length;
    let snapshotSha256 = job.snapshotSha256;
    if (complete) {
      snapshot.assets.push(...progress.assets);
      const json = await immutableJson(this.bucket, `private-snapshots/${id}.json`, snapshot, 10 * 1024 * 1024);
      snapshotSha256 = await sha256(json);
    }
    return this.store.transaction(async tx => {
      const latest = await tx.get<ReleaseJob>(`releases/${id}`);
      assert(latest?.status === 'building' && latest.runId === runId, 'BUILD_STATE_CONFLICT', 409, '构建任务状态已改变');
      if (latest.snapshotPrepared !== false) return latest;
      const next: ReleaseJob = { ...latest, snapshotPrepared: complete, preparedAssetCount: Math.max(latest.preparedAssetCount || 0, preparedAssetCount), snapshotSha256, updatedAt: new Date(this.now()).toISOString() };
      tx.put(`releases/${id}`, next); return next;
    });
  }
  async get(id: string): Promise<ReleaseJob> { IdSchema.parse(id); const job = await this.store.get<ReleaseJob>(`releases/${id}`); assert(job, 'NOT_FOUND', 404, '发布任务不存在'); return job; }
  async claim(id: string, runId: string, codeSha: string): Promise<ReleaseJob> {
    return this.store.transaction(async tx => {
      const job = await tx.get<ReleaseJob>(`releases/${id}`);
      assert(job && (job.status === 'queued' || job.status === 'building' && job.runId === runId), 'BUILD_STATE_CONFLICT', 409, '构建任务已被领取或结束');
      assert(job.codeSha === codeSha, 'BUILD_CODE_MISMATCH', 403, '构建代码版本不匹配');
      const next = { ...job, runId, status: 'building' as const, updatedAt: new Date(this.now()).toISOString() }; tx.put(`releases/${id}`, next); return next;
    });
  }
  async registerManifest(id: string, runId: string, input: unknown): Promise<ReleaseManifest | ManifestPreparation> {
    const files = BuildManifestInputSchema.parse(input).files, job = await this.get(id);
    assert(job.status === 'building' && job.runId === runId, 'BUILD_STATE_CONFLICT', 409, '构建任务状态不符');
    assert(job.snapshotPrepared !== false, 'SNAPSHOT_NOT_PREPARED', 409, '候选资产尚未准备完成');
    assert(new Set(files.map(file => file.path)).size === files.length, 'DUPLICATE_BUILD_PATH', 422, '构建文件地址重复');
    const mappedFiles = files.map(file => ({ ...file, key: `releases/${id}/files${file.path}` })), inputSha256 = await sha256(JSON.stringify(files));
    const registered = await this.bucket.get(`releases/${id}/pending-manifest.json`);
    if (registered) {
      assert(registered.size <= 4 * 1024 * 1024, 'RELEASE_INVALID', 503, '已登记清单大小无效');
      const manifest = await registered.json<ReleaseManifest>();
      assert(manifest.releaseId === id && JSON.stringify(manifest.files) === JSON.stringify(mappedFiles), 'MANIFEST_CONFLICT', 409, '已登记的不可变构建清单不同');
      return manifest;
    }
    const snapshot = await this.snapshot(id), required = ['/', '/about/', '/creations/', '/photography/', '/fitness/', '/guestbook/', '/contact/', ...snapshot.creations.map(v => `/creations/${v.slug}/`), ...snapshot.albums.map(v => `/photography/${v.slug}/`)];
    const paths = new Set(files.map(file => file.path));
    for (const route of required) assert(paths.has(`${route}index.html`), 'BUILD_ROUTE_MISSING', 422, `构建缺少公开页面：${route}`);
    const progressKey = `releases/${id}/manifest-preparation.json`, current = await this.bucket.get(progressKey);
    assert(!current || current.size <= 4 * 1024 * 1024, 'RELEASE_INVALID', 503, '清单准备进度大小无效');
    let progress: ManifestPreparationState = current ? await current.json<ManifestPreparationState>()
      : { inputSha256, snapshotSha256: job.snapshotSha256, processed: 0, assets: {} };
    const validate = () => {
      assert(progress.inputSha256 === inputSha256 && progress.snapshotSha256 === job.snapshotSha256, 'MANIFEST_CONFLICT', 409, '续调的构建清单或冻结快照不同');
      assert(Number.isInteger(progress.processed) && progress.processed >= 0 && progress.processed <= snapshot.assets.length, 'RELEASE_INTEGRITY', 503, '清单准备进度无效');
    };
    validate();
    if (progress.processed < snapshot.assets.length) {
      const targets = snapshot.assets.slice(progress.processed, progress.processed + RELEASE_ASSET_BATCH_SIZE);
      const records = await this.store.getMany<MediaAsset>(targets.map(asset => `media/${asset.id}`)), assets = { ...progress.assets };
      for (const [index, expected] of targets.entries()) {
        const stored = records[index], actual = publicAsset(stored, expected.id);
        assert(JSON.stringify(actual) === JSON.stringify(PublicMediaAssetSchema.parse(expected)), 'MEDIA_CHANGED', 409, '媒体投影与已冻结的构建快照不同');
        for (const variant of stored!.variants) assets[`${stored!.id}/${variant.role}`] = { key: variant.key, mime: variant.mime, bytes: variant.bytes, sha256: variant.sha256 };
      }
      const next: ManifestPreparationState = { ...progress, processed: progress.processed + targets.length, assets }, serialized = JSON.stringify(next);
      assert(new TextEncoder().encode(serialized).length <= 4 * 1024 * 1024, 'RELEASE_TOO_LARGE', 422, '发布媒体清单超过文档大小上限');
      const updated = await this.bucket.put(progressKey, serialized, { onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' } });
      if (updated) progress = next;
      else {
        const winner = await this.bucket.get(progressKey);
        assert(winner && winner.size <= 4 * 1024 * 1024, 'RELEASE_INTEGRITY', 503, '清单准备进度需要重试');
        progress = await winner.json<ManifestPreparationState>(); validate();
      }
    }
    if (progress.processed < snapshot.assets.length) return { pending: true, phase: 'assets', processed: progress.processed, total: snapshot.assets.length };
    const manifest: ReleaseManifest = { releaseId: id, schemaVersion: 1, files: mappedFiles, assets: progress.assets };
    await immutableJson(this.bucket, `releases/${id}/pending-manifest.json`, manifest, 4 * 1024 * 1024);
    return manifest;
  }
  async fail(id: string, runId: string, code: string): Promise<ReleaseJob> {
    const messages = {
      NUXT_BUILD_FAILED: '静态页面生成失败，请检查私有构建日志后重新生成候选。',
      CONTENT_VALIDATION_FAILED: '候选内容未通过结构校验，请检查草稿后重新生成候选。',
      BUILD_INTEGRITY_FAILED: '静态文件或清单未通过完整性校验，请重新生成候选。',
    };
    assert(Object.hasOwn(messages, code), 'INVALID_BUILD_FAILURE', 422, '构建错误分类无效');
    return this.store.transaction(async tx => {
      const current = await tx.get<ReleaseJob>(`releases/${id}`);
      assert(current?.runId === runId, 'BUILD_STATE_CONFLICT', 403, '构建执行器不匹配');
      if (current.status === 'failed') {
        assert(current.error?.code === code, 'BUILD_STATE_CONFLICT', 409, '失败记录已经确定');
        return current;
      }
      assert(current.status === 'building', 'BUILD_STATE_CONFLICT', 409, '当前候选状态不能标记失败');
      const next: ReleaseJob = { ...current, status: 'failed', error: { code, message: messages[code as keyof typeof messages] }, updatedAt: new Date(this.now()).toISOString() };
      tx.put(`releases/${id}`, next);
      return next;
    });
  }
  async finish(id: string, runId: string): Promise<ReleaseJob> {
    const job = await this.get(id); assert(job.status === 'building' && job.runId === runId, 'BUILD_STATE_CONFLICT', 409, '构建任务状态不符');
    const pending = await this.bucket.get(`releases/${id}/pending-manifest.json`); assert(pending && pending.size < 4 * 1024 * 1024, 'MANIFEST_MISSING', 409, '构建清单不存在');
    const manifest = await pending.json<ReleaseManifest>();
    // Each file costs one HEAD plus one immutable lookup PUT. Twelve leaves
    // room for authentication, Firestore transactions and a retry on Free.
    const verifiedFileCount = Math.min(manifest.files.length, (job.verifiedFileCount || 0) + 12);
    await Promise.all(manifest.files.slice(job.verifiedFileCount || 0, verifiedFileCount).map(async file => {
      const object = await this.bucket.head(file.key);
      assert(object && object.size === file.bytes && object.customMetadata?.sha256 === file.sha256, 'BUILD_FILE_MISMATCH', 422, '构建文件尚未上传完整或校验失败');
      await this.bucket.put(`releases/${id}/public-index/files${file.path}.json`, JSON.stringify(file), { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
    }));
    if (verifiedFileCount < manifest.files.length) return this.store.transaction(async tx => {
      const current = await tx.get<ReleaseJob>(`releases/${id}`); assert(current?.status === 'building' && current.runId === runId, 'BUILD_STATE_CONFLICT', 409, '构建任务状态已改变');
      const next = { ...current, verifiedFileCount, updatedAt: new Date(this.now()).toISOString() }; tx.put(`releases/${id}`, next); return next;
    });
    const snapshot = await this.snapshot(id);
    const indices = [...Object.entries(manifest.assets).map(([key, data]) => ({ key: `media/${key}`, data })), ...Object.entries(snapshot.routeAliases).map(([from, to]) => ({ key: `aliases${from}`, data: { location: to } }))];
    const verifiedIndexCount = Math.min(indices.length, (job.verifiedIndexCount || 0) + 12);
    // Do not spend the media-index budget in a request which also verified files.
    if ((job.verifiedFileCount || 0) === manifest.files.length) await Promise.all(indices.slice(job.verifiedIndexCount || 0, verifiedIndexCount).map(index => this.bucket.put(`releases/${id}/public-index/${index.key}.json`, JSON.stringify(index.data), { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } })));
    const indexed = (job.verifiedFileCount || 0) === manifest.files.length ? verifiedIndexCount : job.verifiedIndexCount || 0;
    if (indexed < indices.length || (job.verifiedFileCount || 0) !== manifest.files.length) return this.store.transaction(async tx => {
      const current = await tx.get<ReleaseJob>(`releases/${id}`); assert(current?.status === 'building' && current.runId === runId, 'BUILD_STATE_CONFLICT', 409, '构建任务状态已改变');
      const next = { ...current, verifiedFileCount, verifiedIndexCount: indexed, indexCount: indices.length, updatedAt: new Date(this.now()).toISOString() }; tx.put(`releases/${id}`, next); return next;
    });
    const home = await this.bucket.get(`releases/${id}/files/index.html`); assert(home && home.size < 2 * 1024 * 1024, 'BUILD_HTML_INVALID', 422, '首页 HTML 无效');
    const html = await home.text(); assert(html.includes('hello！i‘m') && html.includes('虚宁') && html.includes(id), 'BUILD_HTML_INVALID', 422, '首页未包含完整原文或发布版本');
    const json = JSON.stringify(manifest), manifestSha256 = await sha256(json);
    await this.bucket.put(`releases/${id}/manifest.json`, json, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
    return this.store.transaction(async tx => {
      const current = await tx.get<ReleaseJob>(`releases/${id}`); assert(current?.status === 'building' && current.runId === runId, 'BUILD_STATE_CONFLICT', 409, '构建任务状态已改变');
      const next = { ...current, status: 'ready' as const, manifestSha256, verifiedFileCount, verifiedIndexCount: indexed, indexCount: indices.length, updatedAt: new Date(this.now()).toISOString() }; tx.put(`releases/${id}`, next); return next;
    });
  }
  async activate(id: string, expectedReleaseId: string | null): Promise<ReleaseJob> {
    const job = await this.get(id), active = await this.active();
    if (active?.value.releaseId === id) return this.reconcile(id);
    assert(['ready', 'live', 'superseded', 'activating', 'reconciling'].includes(job.status), 'RELEASE_NOT_READY', 409, '发布尚未完成验证');
    assert((active?.value.releaseId || null) === expectedReleaseId, 'RELEASE_CONFLICT', 409, '线上版本已改变，请刷新后操作');
    assert(job.manifestSha256 && job.runId, 'RELEASE_NOT_READY', 409, '发布证据不完整');
    await this.store.transaction(async tx => { const current = await tx.get<ReleaseJob>(`releases/${id}`); assert(current, 'NOT_FOUND', 404, '任务不存在'); tx.put(`releases/${id}`, { ...current, status: 'activating', updatedAt: new Date(this.now()).toISOString() }); });
    const pointer: ActiveRelease = { releaseId: id, manifestSha256: job.manifestSha256, schemaVersion: 1, activatedAt: new Date(this.now()).toISOString(), codeSha: job.codeSha, runId: job.runId };
    let written: R2Object | null;
    try { written = await this.bucket.put('active-release.json', JSON.stringify(pointer), { onlyIf: active ? { etagMatches: active.etag } : { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } }); }
    catch {
      await this.store.transaction(async tx => { const current = await tx.get<ReleaseJob>(`releases/${id}`); if (current?.status === 'activating') tx.put(`releases/${id}`, { ...current, status: 'reconciling', updatedAt: new Date(this.now()).toISOString() }); });
      assert(false, 'RELEASE_RECONCILING', 503, '发布响应尚未确认，请刷新状态；重复操作会核对同一候选');
    }
    if (!written) {
      const actual = await this.active();
      if (actual?.value.releaseId === id) return this.reconcile(id);
      await this.store.transaction(async tx => { const current = await tx.get<ReleaseJob>(`releases/${id}`); if (current?.status === 'activating') tx.put(`releases/${id}`, { ...current, status: job.status, updatedAt: new Date(this.now()).toISOString(), error: { code: 'RELEASE_CONFLICT', message: '另一发布已抢先生效，请刷新确认当前版本' } }); });
      assert(false, 'RELEASE_CONFLICT', 409, '另一发布已抢先生效，请刷新确认当前版本');
    }
    return this.reconcile(id);
  }
  async reconcile(id: string): Promise<ReleaseJob> {
    const active = await this.active(), job = await this.get(id);
    if (active?.value.releaseId !== id) return job.status === 'live' ? { ...job, status: 'superseded' } : job;
    assert(active.value.manifestSha256 === job.manifestSha256, 'RELEASE_INTEGRITY', 503, '线上发布清单正在核对');
    if (job.status === 'live' && (job.reconciledRecords || 0) === job.changes.length) return job;
    return this.store.transaction(async tx => {
      const current = await tx.get<ReleaseJob>(`releases/${id}`); assert(current, 'NOT_FOUND', 404, '任务不存在');
      const batch = current.changes.slice(current.reconciledRecords || 0, (current.reconciledRecords || 0) + 10);
      const records = await Promise.all(batch.map(change => tx.get<DraftRecord>(`${change.collection}/${change.id}`)));
      records.forEach((record, index) => { if (!record) return; const change = batch[index]!; tx.put(`${change.collection}/${change.id}`, { ...record, visibility: change.action === 'publish' ? 'published' : 'hidden', lastPublishedRevisionId: change.action === 'publish' ? current.selectedRevisionIds[`${change.collection}/${change.id}`] : record.lastPublishedRevisionId }); });
      const next = { ...current, status: 'live' as const, reconciledRecords: (current.reconciledRecords || 0) + batch.length, updatedAt: new Date(this.now()).toISOString() }; tx.put(`releases/${id}`, next); return next;
    });
  }
}
