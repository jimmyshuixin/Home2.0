import { Hono } from 'hono';
import { z } from 'zod';
import { CreationDraftSchema, AlbumDraftSchema, FitnessEntryDraftSchema, PlaylistDraftSchema, SiteSettingsSchema, FitnessSettingsDraftSchema, CommentInputSchema, ContactInputSchema, CalendarDateError, IdSchema, MediaVariantRoleSchema, fitnessDayCount, shanghaiDate, boundedTreeProblem } from '@xvyin/contracts';
import { AuthError, type AuthProvider } from './auth';
import { ApiError, assert } from './errors';
import { boundedJson, assertOrigin, cookieValue, rateLimit, sha256 } from './security';
import { Sessions, type Session } from './sessions';
import { Records, readStatistics, writeStatisticsDelta, type DraftRecord } from './records';
import { StoreError, type Store } from './store/types';
import { Media, type MediaAsset } from './media';
import { MediaLibrary, type PurgeJob } from './media-library';
import type { PublicReadCache } from './public-read-cache';
import { cachePublishedSection, type PublishedSection } from './public-data';
import { Processing } from './processing';
import { PhotographyBackfill } from './photography-backfill';
import { Releases, emptySnapshot, type Snapshot, type ReleaseJob, type ReleaseManifest } from './releases';
import { renderPublic, serveObject, publicIndex } from './render';
import { AnalyticsQuerySchema, EngagementTargetSchema, LikeInputSchema, VisitInputSchema } from '@xvyin/contracts';
import { cachedLikeCount, Engagement, guardEngagementRequest } from './engagement';
import { readBilibiliProfile, type BilibiliFetch } from './bilibili';
export interface Runtime {
  store: Store; bucket: R2Bucket; auth: AuthProvider; now: () => number; secureCookies: boolean;
  allowedOrigins: string[]; privacySalt: string; adminUsername: string; codeSha: string;
  verifyRunner?: (request: Request) => Promise<{ runId: string; codeSha: string }>;
  dispatchBuild?: (job: ReleaseJob) => Promise<void>;
  music?: (request: Request, snapshot: Snapshot, requestId: string, privateView?: boolean) => Promise<Response>;
  dispatchMedia?: (assetId: string) => Promise<void>;
  publicReadCache?: PublicReadCache;
  bilibiliFetch?: BilibiliFetch;
}
interface CommentRecord { id: string; nickname: string; body: string; targetType: 'guestbook' | 'creation' | 'album'; targetId: string | null; status: 'pending' | 'approved' | 'rejected' | 'hidden'; version: number; createdAt: string; updatedAt: string }
type Context = { Variables: { requestId: string; session: Session; previewId: string | null } };
const saveInput = z.object({ draft: z.unknown(), expectedVersion: z.number().int().nonnegative() }).strict();
const loginInput = z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(512) }).strict();
const schemaFor = (name: string): z.ZodType => ({ creations: CreationDraftSchema, albums: AlbumDraftSchema, fitness: FitnessEntryDraftSchema, playlists: PlaylistDraftSchema })[name as 'creations'];
export function createApi(runtime: Runtime) {
  const app = new Hono<Context>(), sessions = new Sessions(runtime.store, runtime.auth, runtime.secureCookies, runtime.now), records = new Records(runtime.store, runtime.now), media = new Media(runtime.store, runtime.bucket, runtime.now), releases = new Releases(runtime.store, runtime.bucket, runtime.now, runtime.codeSha);
  const previewCookie = runtime.secureCookies ? '__Host-xvyin_preview' : 'xvyin_local_preview';
  const processing = new Processing(runtime.store, runtime.bucket, runtime.now);
  const photographyBackfill = new PhotographyBackfill(runtime.store, runtime.bucket, runtime.now);
  const library = new MediaLibrary(runtime.store, runtime.bucket, runtime.now);
  const engagement = new Engagement(runtime.store, runtime.privacySalt, runtime.now);
  const publicPurge = ({ keys, ...job }: PurgeJob) => ({ ...job, totalKeys: keys.length });
  const response = (data: unknown, requestId: string, extra: Record<string, unknown> = {}, status = 200) => new Response(JSON.stringify({ data, meta: { requestId, schemaVersion: 1, ...extra } }), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  const input = async (request: Request, max?: number) => { const value = await boundedJson(request, max); const problem = boundedTreeProblem(value, 24, 15000); assert(!problem, 'INVALID_CONTENT_TREE', 422, problem || '内容结构无效'); return value; };
  const ip = (request: Request) => request.headers.get('cf-connecting-ip') || 'local';
  const limit = (request: Request, scope: string, count: number, window = 60_000) => rateLimit(runtime.store, scope, ip(request), count, window, runtime.now(), runtime.privacySalt);
  const currentSnapshot = async (request: Request, requestId: string) => {
    const previewId = cookieValue(request, previewCookie);
    if (previewId) { await sessions.require(request); const job = await releases.get(previewId); assert(['ready', 'live', 'superseded'].includes(job.status), 'PREVIEW_NOT_READY', 409, '预览尚未就绪'); return releases.snapshot(previewId); }
    const active = await releases.active(), wanted = request.headers.get('x-xvyin-release');
    assert(!wanted || wanted === 'unpublished' || wanted === active?.value.releaseId, 'RELEASE_CHANGED', 409, '网站已更新，请刷新页面');
    return active ? releases.snapshot(active.value.releaseId) : emptySnapshot('unpublished');
  };
  const publicRecordState = async (collection: string, values: DraftRecord[]) => {
    const active = await releases.active(), snapshot = active ? await releases.snapshot(active.value.releaseId) : emptySnapshot('unpublished');
    const live = collection === 'fitness' ? snapshot.fitness.entries : collection === 'creations' ? snapshot.creations : collection === 'albums' ? snapshot.albums : snapshot.playlists;
    return values.map(record => {
      const published = live.find(item => item.id === record.id);
      return { ...record, visibility: published ? 'published' : record.lastPublishedRevisionId || record.visibility === 'hidden' ? 'hidden' : 'draft', lastPublishedRevisionId: published?.revisionId || record.lastPublishedRevisionId };
    });
  };
  const currentSection = async <K extends PublishedSection>(request: Request, requestId: string, section: K) => {
    if (cookieValue(request, previewCookie)) { const snapshot = await currentSnapshot(request, requestId); return { releaseId: snapshot.releaseId, value: snapshot[section] }; }
    const active = await releases.active(), wanted = request.headers.get('x-xvyin-release');
    assert(!wanted || wanted === 'unpublished' || wanted === active?.value.releaseId, 'RELEASE_CHANGED', 409, '网站已更新，请刷新页面');
    if (!active) return { releaseId: 'unpublished', value: emptySnapshot('unpublished')[section] };
    const releaseId = active.value.releaseId;
    return { releaseId, value: await cachePublishedSection(runtime.publicReadCache, releaseId, section, () => releases.snapshot(releaseId)) };
  };
  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID(); c.set('requestId', requestId);
    c.header('x-request-id', requestId); c.header('x-content-type-options', 'nosniff'); c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'strict-origin-when-cross-origin');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !c.req.path.startsWith('/api/v1/internal/')) assertOrigin(c.req.raw, runtime.allowedOrigins);
    const origin = c.req.header('origin');
    if (origin && runtime.allowedOrigins.includes(origin)) { c.header('access-control-allow-origin', origin); c.header('access-control-allow-credentials', 'true'); c.header('vary', 'Origin, Cookie'); }
    if (c.req.method === 'OPTIONS') {
      assert(origin && runtime.allowedOrigins.includes(origin), 'ORIGIN_REJECTED', 403, '来源未获允许');
      c.header('access-control-allow-methods', 'GET, HEAD, POST, PATCH, PUT, OPTIONS'); c.header('access-control-allow-headers', 'Content-Type, X-CSRF-Token, Idempotency-Key, X-Xvyin-Release'); return c.body(null, 204);
    }
    await next();
  });
  app.onError((error, c) => {
    const requestId = c.get('requestId');
    if (error instanceof z.ZodError) return c.json({ error: { code: 'VALIDATION_ERROR', message: '请检查填写内容', fields: Object.fromEntries(error.issues.map(issue => [issue.path.join('.'), [issue.message]])) }, meta: { requestId, schemaVersion: 1 } }, 422);
    if (error instanceof ApiError || error instanceof AuthError || error instanceof CalendarDateError) return new Response(JSON.stringify({ error: { code: error.code, message: error.message, ...(error instanceof ApiError && error.fields ? { fields: error.fields } : {}) }, meta: { requestId, schemaVersion: 1 } }), { status: error.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(error.status === 429 ? { 'retry-after': '60' } : {}) } });
    // Only classifications and request IDs enter logs; never request bodies or provider errors.
    console.error(JSON.stringify({ level: 'error', code: error instanceof StoreError ? error.code : 'INTERNAL_ERROR', requestId }));
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试' }, meta: { requestId, schemaVersion: 1 } }, 503);
  });
  app.get('/api/v1/health', c => response({ status: 'ok', schemaVersion: 1 }, c.get('requestId')));
  app.get('/api/v1/time', c => response({ now: new Date(runtime.now()).toISOString(), todayDate: shanghaiDate(runtime.now()), timezone: 'Asia/Shanghai' }, c.get('requestId')));
  app.get('/api/v1/bilibili/profile', async c => response(await readBilibiliProfile({ now: runtime.now, cache: runtime.publicReadCache, fetcher: runtime.bilibiliFetch }), c.get('requestId')));
  app.post('/api/v1/auth/login', async c => {
    await limit(c.req.raw, 'login', 8, 15 * 60_000); const values = loginInput.parse(await input(c.req.raw, 4096));
    const identity = await runtime.auth.signIn(values), created = await sessions.create(identity);
    c.header('set-cookie', created.cookie); return c.json({ data: { username: runtime.adminUsername, csrfToken: created.session.csrfToken }, meta: { requestId: c.get('requestId'), schemaVersion: 1 } });
  });
  app.get('/api/v1/auth/session', async c => { const session = await sessions.require(c.req.raw); return response({ username: runtime.adminUsername, csrfToken: session.csrfToken, previewReleaseId: cookieValue(c.req.raw, previewCookie) }, c.get('requestId')); });
  app.post('/api/v1/auth/logout', async c => { const session = await sessions.require(c.req.raw, true); c.header('set-cookie', await sessions.logout(session)); return c.json({ data: { loggedOut: true }, meta: { requestId: c.get('requestId'), schemaVersion: 1 } }); });
  app.post('/api/v1/auth/password', async c => {
    const session = await sessions.require(c.req.raw, true), values = z.object({ currentPassword: z.string().max(512), newPassword: z.string().max(512) }).strict().parse(await input(c.req.raw, 4096));
    await limit(c.req.raw, 'password', 5, 15 * 60_000);
    await runtime.auth.changePassword({ uid: session.uid, ...values }); await sessions.revokeAll(session.uid);
    c.header('set-cookie', await sessions.logout(session)); return c.json({ data: { changed: true }, meta: { requestId: c.get('requestId'), schemaVersion: 1 } });
  });
  app.post('/api/v1/auth/reset/request', async c => { await limit(c.req.raw, 'password-reset', 3, 3600_000); const values = z.object({ username: z.string().min(1).max(128) }).strict().parse(await input(c.req.raw, 4096)); await runtime.auth.requestPasswordReset(values); return response({ accepted: true }, c.get('requestId')); });
  app.post('/api/v1/auth/reset/confirm', async c => { await limit(c.req.raw, 'reset-confirm', 6, 15 * 60_000); const values = z.object({ code: z.string().min(1).max(4096), newPassword: z.string().max(512) }).strict().parse(await input(c.req.raw, 8192)); const result = await runtime.auth.confirmPasswordReset(values); await sessions.revokeAll(result.uid); return response({ changed: true }, c.get('requestId')); });
  app.use('/api/v1/admin/*', async (c, next) => { c.set('session', await sessions.require(c.req.raw, !['GET', 'HEAD'].includes(c.req.method))); await next(); });
  for (const collection of ['creations', 'albums', 'fitness', 'playlists']) {
    app.get(`/api/v1/admin/${collection}`, async c => { const page = await runtime.store.list<DraftRecord>(collection, { limit: 50, cursor: c.req.query('cursor') }); return response(await publicRecordState(collection, page.items.map(item => item.data)), c.get('requestId'), { nextCursor: page.nextCursor }); });
    app.get(`/api/v1/admin/${collection}/:id`, async c => { IdSchema.parse(c.req.param('id')); const value = await runtime.store.get<DraftRecord>(`${collection}/${c.req.param('id')}`); assert(value, 'NOT_FOUND', 404, '内容不存在'); return response((await publicRecordState(collection, [value]))[0], c.get('requestId')); });
    app.post(`/api/v1/admin/${collection}`, async c => { const values = z.object({ draft: z.unknown() }).strict().parse(await input(c.req.raw)); return response(await records.save(collection, schemaFor(collection), values.draft, c.get('session').uid), c.get('requestId'), {}, 201); });
    app.patch(`/api/v1/admin/${collection}/:id`, async c => { const values = saveInput.parse(await input(c.req.raw)); return response(await records.save(collection, schemaFor(collection), values.draft, c.get('session').uid, c.req.param('id'), values.expectedVersion), c.get('requestId')); });
  }
  for (const name of ['site', 'fitness']) {
    const schema: z.ZodType = name === 'site' ? SiteSettingsSchema : FitnessSettingsDraftSchema;
    app.get(`/api/v1/admin/settings/${name}`, async c => {
      const record = await runtime.store.get<DraftRecord>(`settings/${name}`);
      return response(record ? { ...record, draft: schema.parse(record.draft) } : { id: name, version: 0, draft: schema.parse({}), visibility: 'draft', draftRevisionId: null, lastPublishedRevisionId: null, createdAt: null, updatedAt: null }, c.get('requestId'));
    });
    app.patch(`/api/v1/admin/settings/${name}`, async c => { const values = saveInput.parse(await input(c.req.raw)); if (name === 'fitness') fitnessDayCount(FitnessSettingsDraftSchema.parse(values.draft).startDate, runtime.now()); return response(await records.save('settings', schema, values.draft, c.get('session').uid, name, values.expectedVersion), c.get('requestId')); });
  }
  app.get('/api/v1/admin/revisions/:id', async c => { IdSchema.parse(c.req.param('id')); const value = await runtime.store.get(`revisions/${c.req.param('id')}`); assert(value, 'NOT_FOUND', 404, '历史版本不存在'); return response(value, c.get('requestId')); });
  app.get('/api/v1/admin/media', async c => {
    const query = c.req.query(); const page = await library.list({ ...query, ...(query.limit ? { limit: Number(query.limit) } : {}) });
    return response(page.items, c.get('requestId'), { nextCursor: page.nextCursor, scanned: page.scanned, catalogReady: page.catalogReady, quota: await media.quota() });
  });
  app.get('/api/v1/admin/media/catalog', async c => response(await library.catalogStatus(), c.get('requestId')));
  app.post('/api/v1/admin/media/photography-backfill', async c => {
    z.object({}).strict().parse(await input(c.req.raw, 1024));
    assert(runtime.dispatchMedia, 'MEDIA_NOT_CONFIGURED', 503, '旧照片自动识别尚未配置');
    await runtime.dispatchMedia('maintenance-photography-v1');
    return response({ started: true }, c.get('requestId'));
  });
  app.post('/api/v1/admin/media/catalog/advance', async c => response(await library.advanceCatalog(), c.get('requestId')));
  app.get('/api/v1/admin/media/duplicates', async c => response(await library.findDuplicate({ ...c.req.query(), bytes: Number(c.req.query('bytes')) } as Parameters<MediaLibrary['findDuplicate']>[0]), c.get('requestId')));
  app.get('/api/v1/admin/media/purge-jobs/:jobId', async c => response(publicPurge(await library.getPurge(c.req.param('jobId'), c.get('session').uid)), c.get('requestId')));
  for (const action of ['advance', 'confirm', 'cancel'] as const) app.post(`/api/v1/admin/media/purge-jobs/:jobId/${action}`, async c => {
    const method = { advance: 'advancePurge', confirm: 'confirmPurge', cancel: 'cancelPurge' }[action] as 'advancePurge' | 'confirmPurge' | 'cancelPurge';
    return response(publicPurge(await library[method](c.req.param('jobId'), c.get('session').uid)), c.get('requestId'));
  });
  app.patch('/api/v1/admin/media/:id', async c => response(await library.update(c.req.param('id'), await input(c.req.raw, 4096) as Parameters<MediaLibrary['update']>[1]), c.get('requestId')));
  for (const action of ['trash', 'restore'] as const) app.post(`/api/v1/admin/media/:id/${action}`, async c => response(await library[action](c.req.param('id'), await input(c.req.raw, 4096) as { expectedVersion: number }, c.get('session').uid), c.get('requestId')));
  app.post('/api/v1/admin/media/:id/purge-check', async c => response(publicPurge(await library.startPurge(c.req.param('id'), await input(c.req.raw, 4096) as { expectedVersion: number }, c.get('session').uid, c.req.header('idempotency-key') || '')), c.get('requestId'), {}, 201));
  app.get('/api/v1/admin/media/:id', async c => { const id = IdSchema.parse(c.req.param('id')), asset = await runtime.store.get<MediaAsset>(`media/${id}`); assert(asset && !['purging', 'deleted'].includes(asset.lifecycle || ''), 'NOT_FOUND', 404, '媒体不存在或已删除'); return response(asset, c.get('requestId')); });
  app.post('/api/v1/admin/media/uploads', async c => response(media.publicUpload(await media.start(await input(c.req.raw, 4096), c.get('session').uid, c.req.header('idempotency-key'))), c.get('requestId'), {}, 201));
  app.get('/api/v1/admin/media/uploads/:id', async c => { IdSchema.parse(c.req.param('id')); return response(media.publicUpload(await media.get(c.req.param('id'), c.get('session').uid)), c.get('requestId')); });
  app.put('/api/v1/admin/media/uploads/:id/parts/:part', async c => { IdSchema.parse(c.req.param('id')); return response(await media.part(c.req.param('id'), Number(c.req.param('part')), c.req.raw, c.get('session').uid), c.get('requestId')); });
  app.post('/api/v1/admin/media/uploads/:id/complete', async c => { IdSchema.parse(c.req.param('id')); const asset = await media.complete(c.req.param('id'), c.get('session').uid); if (runtime.dispatchMedia && asset.status === 'processing') await runtime.dispatchMedia(asset.id); return response(asset, c.get('requestId')); });
  app.post('/api/v1/admin/media/uploads/:id/abort', async c => { IdSchema.parse(c.req.param('id')); await media.abort(c.req.param('id'), c.get('session').uid); return response({ aborted: true }, c.get('requestId')); });
  app.get('/api/v1/admin/media/:id/:role', async c => {
    IdSchema.parse(c.req.param('id')); const asset = await runtime.store.get<MediaAsset>(`media/${c.req.param('id')}`); assert(asset && !['purging', 'deleted'].includes(asset.lifecycle || ''), 'NOT_FOUND', 404, '媒体不存在或已删除');
    const role = c.req.param('role'), variant = asset.variants.find(v => v.role === role);
    assert(role === 'original' || variant, 'NOT_FOUND', 404, '媒体版本不存在');
    const result = await serveObject(runtime.bucket, variant?.key || asset.originalKey, c.req.raw, variant?.mime || 'application/octet-stream', true, 'private');
    if (role === 'original') result.headers.set('content-disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(asset.originalName)); return result;
  });
  app.get('/api/v1/admin/release-changes', async c => {
    const collection = z.enum(['creations', 'albums', 'fitness', 'playlists', 'settings']).parse(c.req.query('collection'));
    const expected = c.req.query('expectedReleaseId'), expectedReleaseId = expected === undefined ? undefined : expected === 'unpublished' ? null : IdSchema.parse(expected);
    const page = await releases.changesPage(collection, c.req.query('cursor'), expectedReleaseId);
    return response(page.items, c.get('requestId'), { nextCursor: page.nextCursor, activeReleaseId: page.activeReleaseId });
  });
  app.get('/api/v1/admin/releases', async c => { const page = await runtime.store.list('releases', { limit: 50, cursor: c.req.query('cursor') }), active = await releases.active(); return response(page.items.map(item => item.data), c.get('requestId'), { nextCursor: page.nextCursor, activeReleaseId: active?.value.releaseId || null }); });
  app.post('/api/v1/admin/releases', async c => {
    let job = await releases.create(await input(c.req.raw), c.get('session').uid, c.req.header('idempotency-key'));
    if (runtime.dispatchBuild && job.status === 'queued' && job.dispatchState !== 'confirmed') {
      job = await releases.retryDispatchJob(job.id);
      let confirmed = false;
      try { await runtime.dispatchBuild(job); confirmed = true; }
      catch { /* Preserve the saved candidate so the same idempotency key can resume dispatch. */ }
      job = await releases.noteDispatch(job.id, confirmed);
    }
    return response(job, c.get('requestId'), {}, 201);
  });
  app.get('/api/v1/admin/releases/:id', async c => response(await releases.reconcile(c.req.param('id')), c.get('requestId')));
  app.post('/api/v1/admin/releases/:id/retry', async c => {
    let job = await releases.retryDispatchJob(c.req.param('id'));
    assert(runtime.dispatchBuild, 'BUILD_NOT_CONFIGURED', 503, '自动构建尚未配置');
    let confirmed = false;
    try { await runtime.dispatchBuild(job); confirmed = true; }
    catch { /* The queued candidate remains recoverable through this same endpoint. */ }
    job = await releases.noteDispatch(job.id, confirmed, true);
    return response(job, c.get('requestId'));
  });
  app.post('/api/v1/admin/releases/:id/activate', async c => { const values = z.object({ expectedReleaseId: IdSchema.nullable() }).strict().parse(await input(c.req.raw, 4096)); return response(await releases.activate(c.req.param('id'), values.expectedReleaseId), c.get('requestId')); });
  app.post('/api/v1/admin/releases/:id/preview', async c => {
    const job = await releases.get(c.req.param('id')); assert(['ready', 'live', 'superseded'].includes(job.status), 'PREVIEW_NOT_READY', 409, '预览尚未准备好');
    c.header('set-cookie', `${previewCookie}=${job.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800${runtime.secureCookies ? '; Secure' : ''}`);
    return c.json({ data: { previewUrl: '/', previewReleaseId: job.id }, meta: { requestId: c.get('requestId'), schemaVersion: 1 } });
  });
  app.post('/api/v1/admin/preview/close', c => { c.header('set-cookie', `${previewCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${runtime.secureCookies ? '; Secure' : ''}`); return c.json({ data: { closed: true }, meta: { requestId: c.get('requestId'), schemaVersion: 1 } }); });
  for (const collection of ['comments', 'contacts']) app.get(`/api/v1/admin/${collection}`, async c => { const page = await runtime.store.list(collection, { limit: 50, cursor: c.req.query('cursor') }); return response(page.items.map(item => item.data), c.get('requestId'), { nextCursor: page.nextCursor }); });
  app.patch('/api/v1/admin/comments/:id', async c => {
    const id = IdSchema.parse(c.req.param('id')), values = z.object({ status: z.enum(['approved', 'rejected', 'hidden']), expectedVersion: z.number().int().positive() }).strict().parse(await input(c.req.raw, 4096));
    const result = await runtime.store.transaction(async tx => {
      const current = await tx.get<CommentRecord>(`comments/${id}`); assert(current, 'NOT_FOUND', 404, '留言不存在'); assert(current.version === values.expectedVersion, 'VERSION_CONFLICT', 409, '审核状态已改变');
      const statistics = await readStatistics(tx);
      const next = { ...current, status: values.status, version: current.version + 1, updatedAt: new Date(runtime.now()).toISOString() };
      tx.put(`comments/${id}`, next); if (values.status === 'approved') tx.put(`public_comments/${id}`, next); else tx.delete(`public_comments/${id}`);
      tx.put(`audit/${crypto.randomUUID()}`, { action: 'comment_moderated', id, status: values.status, uid: c.get('session').uid, at: next.updatedAt });
      if (current.status === 'pending') writeStatisticsDelta(tx, statistics, { commentsPending: -1 }, next.updatedAt);
      return next;
    }); return response(result, c.get('requestId'));
  });
  app.get('/api/v1/comments', async c => {
    const targetType = z.enum(['guestbook', 'creation', 'album']).parse(c.req.query('targetType') || 'guestbook'), targetId = c.req.query('targetId') || null;
    const snapshot = await currentSnapshot(c.req.raw, c.get('requestId'));
    if (targetType !== 'guestbook') assert((targetType === 'creation' ? snapshot.creations : snapshot.albums).some(v => v.id === targetId), 'NOT_FOUND', 404, '公开内容不存在');
    const page = await runtime.store.list<CommentRecord>('public_comments', { limit: 50, cursor: c.req.query('cursor') });
    return response(page.items.map(item => item.data).filter(v => v.targetType === targetType && v.targetId === targetId && v.status === 'approved').map(({ id, nickname, body, createdAt }) => ({ id, nickname, body, createdAt })), c.get('requestId'), { nextCursor: page.nextCursor, releaseId: snapshot.releaseId });
  });
  for (const kind of ['comment', 'contact']) app.post(`/api/v1/${kind === 'comment' ? 'comments' : 'contact'}`, async c => {
    await limit(c.req.raw, kind, 5, 10 * 60_000); const values = (kind === 'comment' ? CommentInputSchema : ContactInputSchema).parse(await input(c.req.raw, 24_000));
    const snapshot = await currentSnapshot(c.req.raw, c.get('requestId'));
    if ('targetType' in values && values.targetType !== 'guestbook') assert((values.targetType === 'creation' ? snapshot.creations : snapshot.albums).some(v => v.id === values.targetId), 'NOT_FOUND', 404, '公开内容不存在');
    if (kind === 'contact') assert(snapshot.settings.contactEnabled, 'CONTACT_DISABLED', 409, '私信暂未开放');
    const clientKey = z.string().uuid().parse(c.req.header('idempotency-key')), hash = await sha256(JSON.stringify(values)), id = await sha256(`${kind}:${clientKey}`), collection = kind === 'comment' ? 'comments' : 'contacts';
    const receipt = await runtime.store.transaction(async tx => {
      const existing = await tx.get<{ hash: string; receipt: unknown }>(`idempotency/${id}`); if (existing) { assert(existing.hash === hash, 'IDEMPOTENCY_CONFLICT', 409, '重复请求的内容不一致'); return existing.receipt; }
      const statistics = await readStatistics(tx);
      const { challengeToken: _token, website: _website, startedAt: _started, ...safeValues } = values;
      const at = new Date(runtime.now()).toISOString(); const receipt = kind === 'comment' ? { receiptId: id, status: 'pending' } : { receiptId: id };
      tx.put(`${collection}/${id}`, { ...safeValues, id, version: 1, status: kind === 'comment' ? 'pending' : 'unread', createdAt: at, updatedAt: at });
      tx.put(`idempotency/${id}`, { hash, receipt, expiresAt: runtime.now() + 7 * 86400_000 });
      writeStatisticsDelta(tx, statistics, kind === 'comment' ? { commentsPending: 1 } : { contacts: 1 }, at);
      return receipt;
    }); return response(receipt, c.get('requestId'), {}, 202);
  });
  app.get('/api/v1/admin/statistics', async c => {
    const statistics = await readStatistics(runtime.store), counts = statistics?.counts;
    return response({ content: { creations: counts?.creations ?? null, albums: counts?.albums ?? null, fitness: counts?.fitness ?? null, playlists: counts?.playlists ?? null }, moderation: { pending: counts?.commentsPending ?? null, contacts: counts?.contacts ?? null }, media: await media.quota(), traffic: null, statisticsInitializedAt: statistics?.initializedAt ?? null, activeReleaseId: (await releases.active())?.value.releaseId || null }, c.get('requestId'));
  });
  const engagementSnapshot = async () => { const active = await releases.active(); return active ? releases.snapshot(active.value.releaseId) : emptySnapshot('unpublished'); };
  app.post('/api/v1/analytics/visit', async c => {
    if (cookieValue(c.req.raw, previewCookie) || cookieValue(c.req.raw, sessions.cookieName) || c.req.header('dnt') === '1' || c.req.header('sec-gpc') === '1') return response({ recorded: false, reason: 'privacy_or_admin' }, c.get('requestId'));
    guardEngagementRequest(c.req.raw, 'visit', runtime.now());
    const values = VisitInputSchema.parse(await input(c.req.raw, 4096));
    return response(await engagement.visit(c.req.raw, values, await engagementSnapshot()), c.get('requestId'));
  });
  app.get('/api/v1/likes', async c => {
    guardEngagementRequest(c.req.raw, 'likes', runtime.now());
    const target = EngagementTargetSchema.parse({ type: c.req.query('type'), id: c.req.query('id'), ...(c.req.query('parentId') ? { parentId: c.req.query('parentId') } : {}) });
    const visitorId = z.string().uuid().optional().parse(c.req.query('visitorId'));
    const active = await releases.active(), releaseId = active?.value.releaseId || 'unpublished';
    const loadSnapshot = async () => {
      const snapshot = emptySnapshot(releaseId), section = target.type === 'creation' ? 'creations' : target.type === 'fitness' ? 'fitness' : 'albums';
      if (active) { const value = await cachePublishedSection(runtime.publicReadCache, releaseId, section, () => releases.snapshot(releaseId)); Object.assign(snapshot, { [section]: value }); }
      return snapshot;
    };
    const data = visitorId ? await engagement.likes(target, visitorId, await loadSnapshot()) : await cachedLikeCount(runtime.publicReadCache, releaseId, target, async () => engagement.count(target, await loadSnapshot()));
    return response(data, c.get('requestId'));
  });
  app.put('/api/v1/likes', async c => {
    guardEngagementRequest(c.req.raw, 'likes', runtime.now());
    const { visitorId, liked, ...rawTarget } = LikeInputSchema.parse(await input(c.req.raw, 4096));
    const target = EngagementTargetSchema.parse(rawTarget);
    return response(await engagement.setLike(c.req.raw, target, visitorId, liked, await engagementSnapshot()), c.get('requestId'));
  });
  app.get('/api/v1/admin/analytics', async c => {
    const values = AnalyticsQuerySchema.parse({ date: c.req.query('date') || shanghaiDate(runtime.now()), ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}) });
    const result = await engagement.report(values.date, values.cursor); return response(result.report, c.get('requestId'), { nextCursor: result.nextCursor });
  });
  for (const name of ['creations', 'albums', 'playlists', 'fitness', 'settings'] as const) app.get(`/api/v1/${name}`, async c => { const section = await currentSection(c.req.raw, c.get('requestId'), name); return response(section.value, c.get('requestId'), { releaseId: section.releaseId }); });
  app.get('/api/v1/media/:id/:role', async c => {
    const previewId = cookieValue(c.req.raw, previewCookie); if (previewId) { await sessions.require(c.req.raw); const job = await releases.get(previewId); assert(['ready', 'live', 'superseded'].includes(job.status), 'PREVIEW_NOT_READY', 409, '预览尚未准备好'); }
    const releaseId = previewId || (await releases.active())?.value.releaseId;
    assert(releaseId, 'NOT_FOUND', 404, '公开媒体不存在');
    const role = MediaVariantRoleSchema.safeParse(c.req.param('role')); assert(role.success, 'NOT_FOUND', 404, '公开媒体不存在');
    const variant = await publicIndex<ReleaseManifest['assets'][string]>(releases, releaseId, `media/${IdSchema.parse(c.req.param('id'))}/${role.data}`, previewId ? undefined : runtime.publicReadCache);
    assert(variant, 'NOT_FOUND', 404, '公开媒体不存在'); const result = await serveObject(runtime.bucket, variant.key, c.req.raw, variant.mime, Boolean(previewId), releaseId, runtime.publicReadCache);
    if (c.req.param('role') === 'download') result.headers.set('content-disposition', 'attachment'); return result;
  });
  app.all('/api/v1/music/*', async c => { assert(runtime.music, 'MUSIC_NOT_CONFIGURED', 503, '音乐服务暂未配置'); const section = await currentSection(c.req.raw, c.get('requestId'), 'playlists'); return runtime.music(c.req.raw, { ...emptySnapshot(section.releaseId), playlists: section.value }, c.get('requestId'), Boolean(cookieValue(c.req.raw, previewCookie))); });
  const runner = async (request: Request) => {
    if (request.headers.has('authorization')) { assert(runtime.verifyRunner, 'RUNNER_UNAUTHORIZED', 401, '构建执行器未配置'); return runtime.verifyRunner(request); }
    assertOrigin(request, runtime.allowedOrigins); await sessions.require(request, true);
    const run = z.string().uuid().parse(request.headers.get('x-xvyin-local-run'));
    return { runId: `local-${run}`, codeSha: runtime.codeSha };
  };
  const ownedJob = async (request: Request, id: string) => {
    const identity = await runner(request), job = await releases.get(id);
    assert(job.runId === identity.runId && job.codeSha === identity.codeSha && job.status === 'building', 'BUILD_STATE_CONFLICT', 403, '构建任务与执行器不匹配'); return { identity, job };
  };
  app.get('/api/v1/internal/releases/:id', async c => {
    const identity = await runner(c.req.raw), job = await releases.get(IdSchema.parse(c.req.param('id')));
    assert(job.codeSha === identity.codeSha && (job.status === 'queued' || job.runId === identity.runId), 'BUILD_STATE_CONFLICT', 403, '构建任务与执行器不匹配');
    return response(job, c.get('requestId'));
  });
  app.post('/api/v1/internal/releases/:id/claim', async c => { const identity = await runner(c.req.raw); return response(await releases.claim(IdSchema.parse(c.req.param('id')), identity.runId, identity.codeSha), c.get('requestId')); });
  app.post('/api/v1/internal/releases/:id/prepare', async c => { const { identity } = await ownedJob(c.req.raw, c.req.param('id')); return response(await releases.prepareSnapshot(c.req.param('id'), identity.runId), c.get('requestId')); });
  app.get('/api/v1/internal/releases/:id/snapshot', async c => { const { job } = await ownedJob(c.req.raw, c.req.param('id')); assert(job.snapshotPrepared !== false, 'SNAPSHOT_NOT_PREPARED', 409, '候选资产尚未准备完成'); return response(await releases.snapshot(c.req.param('id')), c.get('requestId')); });
  app.post('/api/v1/internal/releases/:id/manifest', async c => { const { identity } = await ownedJob(c.req.raw, c.req.param('id')); return response(await releases.registerManifest(c.req.param('id'), identity.runId, await input(c.req.raw, 4 * 1024 * 1024)), c.get('requestId')); });
  app.put('/api/v1/internal/releases/:id/file', async c => {
    await ownedJob(c.req.raw, c.req.param('id'));
    const pending = await runtime.bucket.get(`releases/${c.req.param('id')}/pending-manifest.json`); assert(pending && pending.size < 4 * 1024 * 1024, 'MANIFEST_MISSING', 409, '构建清单不存在');
    const manifest = await pending.json<ReleaseManifest>(), file = manifest.files.find(v => v.path === c.req.query('path'));
    assert(file && file.bytes <= 25 * 1024 * 1024, 'BUILD_PATH_REJECTED', 403, '构建文件不在清单中');
    const existing = await runtime.bucket.head(file.key);
    if (existing) { assert(existing.size === file.bytes && existing.customMetadata?.sha256 === file.sha256, 'IMMUTABLE_FILE_CONFLICT', 409, '不可变构建文件已存在且校验不同'); return response({ uploaded: true, reused: true }, c.get('requestId')); }
    assert(Number(c.req.header('content-length')) === file.bytes && c.req.raw.body, 'BUILD_SIZE_MISMATCH', 422, '构建文件大小不符');
    const object = await runtime.bucket.put(file.key, c.req.raw.body, { onlyIf: { etagDoesNotMatch: '*' }, sha256: file.sha256, httpMetadata: { contentType: file.contentType }, customMetadata: { sha256: file.sha256 } });
    assert(object?.size === file.bytes, 'BUILD_SIZE_MISMATCH', 422, '构建文件校验失败'); return response({ uploaded: true }, c.get('requestId'));
  });
  app.post('/api/v1/internal/releases/:id/finish', async c => { const { identity } = await ownedJob(c.req.raw, c.req.param('id')); return response(await releases.finish(c.req.param('id'), identity.runId), c.get('requestId')); });
  app.post('/api/v1/internal/releases/:id/fail', async c => {
    const identity = await runner(c.req.raw), job = await releases.get(IdSchema.parse(c.req.param('id')));
    assert(job.codeSha === identity.codeSha && job.runId === identity.runId, 'BUILD_STATE_CONFLICT', 403, '构建执行器不匹配');
    const values = z.object({ code: z.enum(['NUXT_BUILD_FAILED', 'CONTENT_VALIDATION_FAILED', 'BUILD_INTEGRITY_FAILED']) }).strict().parse(await input(c.req.raw, 1024));
    return response(await releases.fail(job.id, identity.runId, values.code), c.get('requestId'));
  });
  const processingRunner = async (request: Request) => { const identity = await runner(request); assert(identity.codeSha === runtime.codeSha && /^[a-f0-9]{40}$/u.test(identity.codeSha), 'BUILD_CODE_MISMATCH', 403, '媒体处理代码版本不匹配'); return identity; };
  app.get('/api/v1/internal/photography', async c => { await processingRunner(c.req.raw); const cursor = z.string().max(8192).optional().parse(c.req.query('cursor')); return response(await photographyBackfill.page(cursor), c.get('requestId')); });
  app.get('/api/v1/internal/photography/:id/source', async c => { await processingRunner(c.req.raw); return photographyBackfill.source(IdSchema.parse(c.req.param('id'))); });
  app.post('/api/v1/internal/photography/:id/complete', async c => { await processingRunner(c.req.raw); return response(await photographyBackfill.complete(IdSchema.parse(c.req.param('id')), await input(c.req.raw, 4096)), c.get('requestId')); });
  app.post('/api/v1/internal/processing/:id/claim', async c => { const identity = await processingRunner(c.req.raw); return response(await processing.claim(IdSchema.parse(c.req.param('id')), identity.runId), c.get('requestId')); });
  app.get('/api/v1/internal/processing/:id/status', async c => { const identity = await processingRunner(c.req.raw); return response(processing.publicJob(await processing.get(IdSchema.parse(c.req.param('id')), identity.runId)), c.get('requestId')); });
  app.get('/api/v1/internal/processing/:id/source', async c => { const identity = await processingRunner(c.req.raw); return processing.source(IdSchema.parse(c.req.param('id')), identity.runId, c.req.raw); });
  app.post('/api/v1/internal/processing/:id/plan', async c => { const identity = await processingRunner(c.req.raw); return response(await processing.plan(IdSchema.parse(c.req.param('id')), identity.runId, await input(c.req.raw, 24000)), c.get('requestId')); });
  app.put('/api/v1/internal/processing/:id/parts/:role/:part', async c => { const identity = await processingRunner(c.req.raw); return response(await processing.part(IdSchema.parse(c.req.param('id')), identity.runId, MediaVariantRoleSchema.parse(c.req.param('role')), Number(c.req.param('part')), c.req.raw), c.get('requestId')); });
  app.post('/api/v1/internal/processing/:id/complete/:role', async c => { const identity = await processingRunner(c.req.raw); return response(await processing.completeVariant(IdSchema.parse(c.req.param('id')), identity.runId, MediaVariantRoleSchema.parse(c.req.param('role'))), c.get('requestId')); });
  app.post('/api/v1/internal/processing/:id/finish', async c => { const identity = await processingRunner(c.req.raw); return response(await processing.finish(IdSchema.parse(c.req.param('id')), identity.runId), c.get('requestId')); });
  app.post('/api/v1/internal/processing/:id/fail', async c => { const identity = await processingRunner(c.req.raw); const error = z.object({ code: z.string().regex(/^[A-Z_]{1,60}$/u), message: z.string().max(300) }).strict().parse(await input(c.req.raw, 4096)); await processing.fail(IdSchema.parse(c.req.param('id')), identity.runId, error); return response({ failed: true }, c.get('requestId')); });
  app.notFound(async c => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: { code: 'NOT_FOUND', message: '接口不存在' }, meta: { requestId: c.get('requestId'), schemaVersion: 1 } }, 404);
    const previewId = cookieValue(c.req.raw, previewCookie); if (previewId) await sessions.require(c.req.raw);
    return renderPublic(releases, c.req.raw, previewId, previewId ? undefined : runtime.publicReadCache);
  });
  return { app, sessions, records, media, processing, releases, response, input };
}
