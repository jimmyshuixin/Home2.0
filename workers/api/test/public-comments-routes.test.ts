import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createApi } from '../src/app';
import type { AuthProvider } from '../src/auth';
import { emptySnapshot, Releases } from '../src/releases';
import type { PublicReadCache } from '../src/public-read-cache';
import { SqliteStore } from '../src/store/sqlite';
import type { CommentCatalogState } from '../src/store/public-comments';

const origin = 'https://comments.invalid', now = Date.UTC(2026, 8, 29), at = new Date(now).toISOString();
let mf: Miniflare, bucket: R2Bucket, store: SqliteStore, api: ReturnType<typeof createApi>, cookie: string, csrf: string;
const auth: AuthProvider = { signIn: async () => ({ uid: 'admin', authTime: now / 1000 }), assertSession: async () => {}, changePassword: async () => {}, requestPasswordReset: async () => {}, confirmPasswordReset: async () => ({ uid: 'admin' }), revokeAllSessions: async () => {} };
beforeAll(async () => {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("test")}}', compatibilityDate: '2026-09-11', r2Buckets: ['COMMENTS'] }), telemetry: { enabled: false }, cf: false });
  bucket = await mf.getR2Bucket('COMMENTS') as unknown as R2Bucket;
  await bucket.put('active-release.json', JSON.stringify({ schemaVersion: 1, releaseId: 'comments-release' }));
  await bucket.put('private-snapshots/comments-release.json', JSON.stringify({ ...emptySnapshot('comments-release'), creations: [{ id: 'creation-one' }], albums: [{ id: 'album-one' }] }));
});
beforeEach(async () => {
  store = new SqliteStore(':memory:');
  api = createApi({ store, bucket, auth, now: () => now, secureCookies: true, allowedOrigins: [origin], privacySalt: 'test-only-salt-'.repeat(4), adminUsername: 'admin', codeSha: 'a'.repeat(40) });
  const session = await api.sessions.create({ uid: 'admin', authTime: now / 1000 }); cookie = session.cookie.split(';')[0]!; csrf = session.session.csrfToken;
  await store.transaction(async tx => {
    for (let i = 0; i < 55; i++) { const id = `a${String(i).padStart(3, '0')}`; tx.put(`public_comments/${id}`, { id, nickname: '摄影访客', body: '摄影留言', targetType: 'album', targetId: 'album-one', status: 'approved', version: 1, createdAt: at, updatedAt: at }); }
    for (let i = 0; i < 30; i++) { const id = `z${String(i).padStart(3, '0')}`, row = { id, nickname: '首页访客', body: '首页留言', targetType: 'guestbook', targetId: null, status: 'approved', version: 1, createdAt: at, updatedAt: at }; tx.put(`comments/${id}`, row); tx.put(`public_comments/${id}`, row); }
  });
});
afterEach(async () => { vi.restoreAllMocks(); await store.close(); });
afterAll(async () => { await mf?.dispose(); });

function request(path: string, options: { method?: string; body?: unknown; admin?: boolean; csrf?: boolean; origin?: string } = {}) {
  return api.app.request(`${origin}/api/v1${path}`, { method: options.method ?? 'GET', headers: { origin: options.origin ?? origin, ...(options.admin ? { cookie } : {}), ...(options.admin && options.csrf !== false ? { 'x-csrf-token': csrf } : {}), ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
}
async function migrate() {
  let state: CommentCatalogState | undefined;
  for (let i = 0; !state?.ready && i < 30; i++) {
    const response = await request('/admin/comments/catalog/advance', { method: 'POST', body: {}, admin: true }); expect(response.status).toBe(200);
    const result = await response.json() as { data: CommentCatalogState }; state = result.data;
  }
  expect(state?.ready).toBe(true); return state!;
}

describe('createApi comment routes with SQLite and local workerd R2', () => {
  it('serves guestbook comments without a content snapshot dependency while retaining release and preview guards', async () => {
    await migrate();
    const snapshot = vi.spyOn(Releases.prototype, 'snapshot').mockRejectedValue(new Error('snapshot temporarily unavailable'));
    const result = await request('/comments?limit=12');
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ data: expect.any(Array), meta: { releaseId: 'comments-release', catalogReady: true } });
    expect(snapshot).not.toHaveBeenCalled();
    const changed = await api.app.request(`${origin}/api/v1/comments`, { headers: { 'x-xvyin-release': 'stale-release' } });
    expect(changed.status).toBe(409); expect(await changed.json()).toMatchObject({ error: { code: 'RELEASE_CHANGED' } });
    const unauthenticated = await api.app.request(`${origin}/api/v1/comments`, { headers: { cookie: '__Host-xvyin_preview=private-comments' } });
    expect(unauthenticated.status).toBe(401);
    await store.transaction(async tx => { tx.put('releases/private-comments', { id: 'private-comments', status: 'building' }); });
    const headers = { cookie: `${cookie}; __Host-xvyin_preview=private-comments` };
    expect((await api.app.request(`${origin}/api/v1/comments`, { headers })).status).toBe(409);
    await store.transaction(async tx => { tx.put('releases/private-comments', { id: 'private-comments', status: 'ready' }); });
    const preview = await api.app.request(`${origin}/api/v1/comments?limit=1`, { headers });
    expect(preview.status).toBe(200); expect(preview.headers.get('cache-control')).toBe('no-store');
    expect(await preview.json()).toMatchObject({ meta: { releaseId: 'private-comments' } });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('reuses the published target section without caching comments, stale release pointers or private preview targets', async () => {
    await migrate();
    const storage = await mf.getCaches(), cache = await storage.open(`comment-target-${crypto.randomUUID()}`);
    let writes = 0;
    const publicReadCache: PublicReadCache = { origin, cache: {
      match: (async (...args: Parameters<Cache['match']>) => {
        const hit = await cache.match(...args as Parameters<typeof cache.match>);
        return hit && new Response(await hit.arrayBuffer(), { status: hit.status, headers: hit.headers });
      }) as Cache['match'],
      put: (async (...args: Parameters<Cache['put']>) => { writes++; return cache.put(...args as unknown as Parameters<typeof cache.put>); }) as Cache['put'],
    } };
    api = createApi({ store, bucket, auth, now: () => now, secureCookies: true, allowedOrigins: [origin], privacySalt: 'test-only-salt-'.repeat(4), adminUsername: 'admin', codeSha: 'a'.repeat(40), publicReadCache });
    const snapshot = vi.spyOn(Releases.prototype, 'snapshot');
    for (let i = 0; i < 2; i++) expect((await request('/comments?targetType=album&targetId=album-one&limit=1')).status).toBe(200);
    expect(snapshot).toHaveBeenCalledTimes(1); expect(writes).toBe(1);
    // Even a warm target section must not keep a newly hidden comment visible.
    await store.transaction(async tx => { tx.delete('public_comment_catalog/a054'); });
    const hidden = await request('/comments?targetType=album&targetId=album-one&limit=1');
    expect(await hidden.json()).toMatchObject({ data: [{ id: 'a053' }] });
    expect(snapshot).toHaveBeenCalledTimes(1); expect(writes).toBe(1);
    await store.transaction(async tx => { tx.put('releases/private-targets', { id: 'private-targets', status: 'ready' }); });
    await bucket.put('private-snapshots/private-targets.json', JSON.stringify({ ...emptySnapshot('private-targets'), albums: [{ id: 'private-album' }] }));
    const headers = { cookie: `${cookie}; __Host-xvyin_preview=private-targets` };
    expect((await api.app.request(`${origin}/api/v1/comments?targetType=album&targetId=album-one`, { headers })).status).toBe(404);
    const preview = await api.app.request(`${origin}/api/v1/comments?targetType=album&targetId=private-album`, { headers });
    expect(preview.status).toBe(200); expect(await preview.json()).toMatchObject({ data: [], meta: { releaseId: 'private-targets' } });
    expect(writes).toBe(1);
    await bucket.put('active-release.json', JSON.stringify({ schemaVersion: 1, releaseId: 'next-comments' }));
    await bucket.put('private-snapshots/next-comments.json', JSON.stringify(emptySnapshot('next-comments')));
    try {
      expect((await request('/comments?targetType=album&targetId=album-one')).status).toBe(404);
      const guestbook = await request('/comments?limit=1');
      expect(await guestbook.json()).toMatchObject({ meta: { releaseId: 'next-comments' } });
      expect((await request('/comments?targetType=creation&targetId=creation-one')).status).toBe(404);
    } finally { await bucket.put('active-release.json', JSON.stringify({ schemaVersion: 1, releaseId: 'comments-release' })); }
  });

  it('protects migration reads and writes with admin auth, CSRF, Origin and strict request input', async () => {
    expect((await request('/admin/comments/catalog')).status).toBe(401);
    expect((await request('/admin/comments/catalog/advance', { method: 'POST', body: {} })).status).toBe(401);
    expect((await request('/admin/comments/catalog/advance', { method: 'POST', body: {}, admin: true, csrf: false })).status).toBe(403);
    expect((await request('/admin/comments/catalog/advance', { method: 'POST', body: {}, admin: true, origin: 'https://foreign.invalid' })).status).toBe(403);
    expect((await request('/admin/comments/catalog/advance', { method: 'POST', body: { cursor: 'forged' }, admin: true })).status).toBe(422);
    const initial = await request('/admin/comments/catalog', { admin: true }); expect(initial.status).toBe(200); expect((await initial.json() as { data: CommentCatalogState }).data).toMatchObject({ ready: false, processed: 0 });
    const first = await request('/admin/comments/catalog/advance', { method: 'POST', body: {}, admin: true }); expect(first.status).toBe(200); expect((await first.json() as { data: CommentCatalogState }).data).toMatchObject({ ready: false, processed: 5 });
  });

  it('retains explicit legacy metadata, then honors latest limits and target-bound cursors after migration', async () => {
    const legacy = await request('/comments?limit=12'); expect(legacy.status).toBe(200);
    expect(await legacy.json()).toMatchObject({ data: [], meta: { catalogReady: false, releaseId: 'comments-release' } });
    expect((await migrate()).processed).toBe(85);
    const response = await request('/comments?limit=12'); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const page = await response.json() as { data: { id: string }[]; meta: { nextCursor: string; catalogReady: boolean } };
    expect(page.data).toHaveLength(12); expect(page.data[0]!.id).toBe('z029'); expect(page.meta.catalogReady).toBe(true);
    const next = await request(`/comments?limit=12&cursor=${encodeURIComponent(page.meta.nextCursor)}`); expect(next.status).toBe(200); expect((await next.json() as { data: { id: string }[] }).data[0]!.id).toBe('z017');
    const other = await request(`/comments?targetType=album&targetId=album-one&cursor=${encodeURIComponent(page.meta.nextCursor)}`); expect(other.status).toBe(422); expect(await other.json()).toMatchObject({ error: { code: 'INVALID_CURSOR' } });
    for (const limit of ['0', '51', '-1', 'text', '1.5', '']) expect((await request(`/comments?limit=${limit}`)).status).toBe(422);
    expect((await request('/comments?targetType=creation&targetId=unpublished')).status).toBe(404);
  });

  it('makes moderated hiding and approval visible immediately without a stale public cache', async () => {
    await migrate();
    const hide = await request('/admin/comments/z029', { method: 'PATCH', body: { status: 'hidden', expectedVersion: 1 }, admin: true }); expect(hide.status).toBe(200);
    const hidden = await request('/comments?limit=1'); expect((await hidden.json() as { data: { id: string }[] }).data[0]!.id).toBe('z028');
    const approved = await request('/admin/comments/z029', { method: 'PATCH', body: { status: 'approved', expectedVersion: 2 }, admin: true }); expect(approved.status).toBe(200);
    const visible = await request('/comments?limit=1'); expect((await visible.json() as { data: { id: string }[] }).data[0]!.id).toBe('z029');
  });
});
