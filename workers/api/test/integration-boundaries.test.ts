import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { AlbumDraftSchema, CreationDraftSchema, MEDIA_LIMITS } from '@xvyin/contracts';
import { createApi, type Runtime } from '../src/app';
import { AuthError, type AuthProvider } from '../src/auth';
import worker from '../src/index';
import { installStatisticsProjection, statisticsRebuildPage, type StatisticsProjection } from '../src/records';
import { Media, PART_SIZE, type MediaAsset, type Upload } from '../src/media';
import { type ReleaseJob, type Snapshot } from '../src/releases';
import { sha256 } from '../src/security';
import { MemoryStore } from '../src/store/memory';

// Test data only. R2 multipart, conditional writes and byte ranges run in the real
// local workerd implementation. No Cloudflare or Firebase account is contacted.
const origin = 'https://test.invalid';
const instant = Date.UTC(2026, 8, 12, 4);
const uid = 'test_admin';
const codeSha = 'a'.repeat(40);
let mf: Miniflare;
let bucket: R2Bucket;
let store: MemoryStore;
let auth: AuthProvider;
let api: ReturnType<typeof createApi>;

beforeAll(async () => {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("local integration test"); } }', compatibilityDate: '2026-09-11', r2Buckets: ['MEDIA'] }), telemetry: { enabled: false }, cf: false });
  bucket = await mf.getR2Bucket('MEDIA') as unknown as R2Bucket;
});
beforeEach(async () => {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor });
    if (page.objects.length) await bucket.delete(page.objects.map(object => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  store = new MemoryStore();
  auth = {
    signIn: vi.fn(async () => ({ uid, authTime: Math.floor(instant / 1000) })),
    assertSession: vi.fn(async () => {}), changePassword: vi.fn(async () => {}),
    requestPasswordReset: vi.fn(async () => {}), confirmPasswordReset: vi.fn(async () => ({ uid })),
    revokeAllSessions: vi.fn(async () => {}),
  };
  const runtime: Runtime = { store, bucket, auth, now: () => instant, secureCookies: true, allowedOrigins: [origin], privacySalt: 'test-only-salt-'.repeat(4), adminUsername: 'test-admin', codeSha };
  api = createApi(runtime);
});
afterAll(async () => { await mf?.dispose(); });

type Login = { cookie: string; csrf: string };
async function login(): Promise<Login> {
  const response = await api.app.request(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'test-admin', password: 'unit-test-password' }) });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')!;
  expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Strict');
  const body = await response.json() as { data: { csrfToken: string } };
  return { cookie: cookie.split(';')[0]!, csrf: body.data.csrfToken };
}
function request(path: string, session?: Login, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return api.app.request(`${origin}${path}`, { method: options.method || 'GET', headers: { origin, ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...options.headers }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
}
const creation = (title: string) => CreationDraftSchema.parse({ title, slug: 'test-creation', blocks: [{ id: 'quote', type: 'quote', text: 'Explicit integration test content' }] });
async function seedAsset(id: string): Promise<MediaAsset> {
  const bytes = new TextEncoder().encode('test-only-image-bytes');
  const key = `variants/${id}/content.webp`, hash = await sha256(bytes), at = new Date(instant).toISOString();
  await bucket.put(key, bytes);
  await bucket.put(`originals/${id}/source`, 'PRIVATE ORIGINAL');
  const asset: MediaAsset = { id, kind: 'image', originalName: 'private-original.jpg', originalKey: `originals/${id}/source`, originalBytes: 16, expectedMime: 'image/jpeg', status: 'ready', variants: [{ role: 'content', key, sha256: hash, mime: 'image/webp', bytes: bytes.length, url: `/api/v1/media/${id}/content`, width: 1, height: 1 }], createdAt: at, updatedAt: at };
  await store.transaction(async tx => { tx.put(`media/${id}`, asset); });
  return asset;
}
async function finishBuild(job: ReleaseJob): Promise<ReleaseJob> {
  const runId = `test-run-${job.id}`;
  let claimed = await api.releases.claim(job.id, runId, codeSha);
  for (let step = 0; claimed.snapshotPrepared === false && step < 100; step++) claimed = await api.releases.prepareSnapshot(job.id, runId);
  expect(claimed.snapshotPrepared).not.toBe(false);
  const snapshot = await api.releases.snapshot(job.id);
  const paths = ['/', '/about/', '/creations/', '/photography/', '/fitness/', '/guestbook/', '/contact/', ...snapshot.creations.map(value => `/creations/${value.slug}/`), ...snapshot.albums.map(value => `/photography/${value.slug}/`)];
  const html = `<!doctype html><html><body>hello！i‘m 虚宁 ${job.id} TEST CONTENT</body></html>`;
  const hash = await sha256(html), bytes = new TextEncoder().encode(html).length;
  const files = paths.map(path => ({ path: `${path}index.html`, sha256: hash, bytes, contentType: 'text/html; charset=utf-8' }));
  let manifest = await api.releases.registerManifest(job.id, runId, { files });
  for (let step = 0; 'pending' in manifest && step < 100; step++) manifest = await api.releases.registerManifest(job.id, runId, { files });
  if ('pending' in manifest) throw new Error('Manifest did not finish preparation');
  for (const file of manifest.files) await bucket.put(file.key, html, { customMetadata: { sha256: hash } });
  for (let step = 0; step < 100; step++) { const result = await api.releases.finish(job.id, runId); if (result.status === 'ready') return result; }
  throw new Error('Test candidate did not complete bounded validation');
}
async function readyCreation(title = 'Integration test creation'): Promise<ReleaseJob> {
  const record = await api.records.save('creations', CreationDraftSchema, creation(title), uid);
  return finishBuild(await api.releases.create({ changes: [{ collection: 'creations', id: record.id, version: 1, action: 'publish' }], expectedReleaseId: null }, uid));
}

describe('HTTP authentication, moderation and optimistic updates', () => {
  it('rejects unauthenticated and cross-origin mutations, and enforces CSRF on admin writes', async () => {
    expect((await request('/api/v1/admin/creations')).status).toBe(401);
    const session = await login();
    expect((await request('/api/v1/admin/creations', session, { method: 'POST', body: { draft: creation('test') }, headers: { origin: 'https://attacker.invalid' } })).status).toBe(403);
    expect((await request('/api/v1/admin/creations', session, { method: 'POST', body: { draft: creation('test') }, headers: { 'x-csrf-token': 'wrong' } })).status).toBe(403);
    expect((await store.list('creations')).items).toEqual([]);
  });

  it('loads all admin list routes and public comments within the storage page bound', async () => {
    const session = await login();
    for (const path of ['creations', 'albums', 'fitness', 'playlists', 'media', 'releases', 'comments', 'contacts', 'statistics']) {
      const response = await request(`/api/v1/admin/${path}`, session);
      expect(response.status, path).toBe(200);
    }
    expect((await request('/api/v1/comments')).status).toBe(200);
  });

  it('revokes every prior browser session after a password change', async () => {
    const first = await login(), second = await login();
    const changed = await request('/api/v1/auth/password', first, { method: 'POST', body: { currentPassword: 'old-test-password', newPassword: 'new-test-password-long' } });
    expect(changed.status).toBe(200);
    expect(auth.changePassword).toHaveBeenCalledWith({ uid, currentPassword: 'old-test-password', newPassword: 'new-test-password-long' });
    expect((await request('/api/v1/auth/session', first)).status).toBe(401);
    expect((await request('/api/v1/auth/session', second)).status).toBe(401);
    const fresh = await login();
    expect((await request('/api/v1/auth/session', fresh)).status).toBe(200);
  });

  it('allows only one update from the same draft version and never overwrites its winning revision', async () => {
    const session = await login();
    const record = await api.records.save('creations', CreationDraftSchema, creation('before'), uid);
    const results = await Promise.all(['first edit', 'second edit'].map(title => request(`/api/v1/admin/creations/${record.id}`, session, { method: 'PATCH', body: { expectedVersion: 1, draft: creation(title) } })));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const stored = await store.get<{ version: number; draft: { title: string }; draftRevisionId: string }>(`creations/${record.id}`);
    expect(stored?.version).toBe(2);
    const revision = await store.get<{ data: { title: string } }>(`revisions/${stored!.draftRevisionId}`);
    expect(revision?.data.title).toBe(stored?.draft.title);
    expect((await store.list('revisions')).items).toHaveLength(2);
  });

  it('publishes anonymous comments only after approval and preserves a retry receipt', async () => {
    const key = crypto.randomUUID(), body = { targetType: 'guestbook', nickname: '测试访客', body: 'This is a test comment' };
    const first = await request('/api/v1/comments', undefined, { method: 'POST', body, headers: { 'idempotency-key': key } });
    const second = await request('/api/v1/comments', undefined, { method: 'POST', body, headers: { 'idempotency-key': key } });
    expect(first.status).toBe(202); expect(second.status).toBe(202);
    const receipt = await first.json() as { data: { receiptId: string } };
    expect((await second.json() as { data: unknown }).data).toEqual(receipt.data);
    expect((await (await request('/api/v1/comments')).json() as { data: unknown[] }).data).toEqual([]);
    const session = await login();
    expect((await request(`/api/v1/admin/comments/${receipt.data.receiptId}`, session, { method: 'PATCH', body: { status: 'approved', expectedVersion: 1 } })).status).toBe(200);
    const published = await (await request('/api/v1/comments')).json() as { data: Array<Record<string, unknown>> };
    expect(published.data).toHaveLength(1); expect(published.data[0]?.body).toBe(body.body);
    expect(published.data[0]).not.toHaveProperty('version'); expect(published.data[0]).not.toHaveProperty('status');
    expect((await request('/api/v1/comments', undefined, { method: 'POST', body: { ...body, body: 'changed payload' }, headers: { 'idempotency-key': key } })).status).toBe(409);
  });

  it('keeps public HTML and release data readable while the authentication provider is unavailable', async () => {
    const ready = await readyCreation(); await api.releases.activate(ready.id, null);
    const session = await login();
    vi.mocked(auth.assertSession).mockRejectedValue(new AuthError('AUTH_UNAVAILABLE'));
    vi.mocked(auth.signIn).mockRejectedValue(new AuthError('AUTH_UNAVAILABLE'));
    expect((await request('/api/v1/admin/creations', session)).status).toBe(503);
    expect((await request('/', session)).status).toBe(200);
    expect((await request('/api/v1/creations', session)).status).toBe(200);
    expect((await request('/api/v1/settings')).status).toBe(200);
  });

  it('keeps the Worker public entry point usable when credential JSON is structurally present but invalid', async () => {
    const ready = await readyCreation(); await api.releases.activate(ready.id, null);
    const env = { CONTENT: bucket, PUBLIC_ORIGIN: origin, BUILD_CODE_SHA: codeSha, FIREBASE_PROJECT_ID: '', FIRESTORE_DATABASE_ID: '', FIRESTORE_EDITION: 'standard', BUILD_REPOSITORY: 'test/example', BUILD_REF: 'refs/heads/test', GOOGLE_SERVICE_ACCOUNT: JSON.stringify({ project_id: '', client_email: '', private_key: '' }) } as unknown as ApiEnv;
    const response = await worker.fetch(new Request(`${origin}/`) as Parameters<typeof worker.fetch>[0], env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(ready.id);
  });

  it('rejects a session revoked while its provider check was still in flight', async () => {
    const session = await login();
    let entered!: () => void, release!: () => void;
    const checking = new Promise<void>(resolve => { entered = resolve; });
    const continueCheck = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(auth.assertSession).mockImplementationOnce(async () => { entered(); await continueCheck; });
    const pending = request('/api/v1/admin/creations', session, { method: 'POST', body: { draft: creation('must not save') } });
    await checking;
    try { await api.sessions.revokeAll(uid); } finally { release(); }
    expect((await pending).status).toBe(401);
    expect((await store.list('creations')).items).toHaveLength(0);
  });

  it('reports unknown statistics without scanning collections or assuming existing records are zero', async () => {
    await api.records.save('creations', CreationDraftSchema, creation('existing test data'), uid);
    const session = await login(), list = vi.spyOn(store, 'list').mockRejectedValue(new Error('Statistics must not scan'));
    try {
      const response = await request('/api/v1/admin/statistics', session);
      expect(response.status).toBe(200);
      const result = await response.json() as { data: { content: Record<string, unknown>; moderation: Record<string, unknown> } };
      expect(Object.values(result.data.content)).toEqual([null, null, null, null]);
      expect(Object.values(result.data.moderation)).toEqual([null, null]);
      expect(list).not.toHaveBeenCalled();
    } finally { list.mockRestore(); }
  });

  it('counts concurrent creates and idempotent submissions once and decrements pending moderation once', async () => {
    await installStatisticsProjection(store, { creations: 0, albums: 0, fitness: 0, playlists: 0, commentsPending: 0, contacts: 0 }, null, instant);
    const [first] = await Promise.all(['one', 'two'].map(title => api.records.save('creations', CreationDraftSchema, creation(title), uid)));
    await api.records.save('creations', CreationDraftSchema, creation('edited'), uid, first!.id, 1);
    const key = crypto.randomUUID(), body = { targetType: 'guestbook', body: 'Test projection receipt' };
    const submitted = await Promise.all([1, 2].map(() => request('/api/v1/comments', undefined, { method: 'POST', body, headers: { 'idempotency-key': key } })));
    expect(submitted.map(value => value.status)).toEqual([202, 202]);
    const receipt = await submitted[0]!.json() as { data: { receiptId: string } };
    let projection = await store.get<StatisticsProjection>('system/statistics');
    expect(projection?.counts).toMatchObject({ creations: 2, commentsPending: 1 });
    const session = await login();
    await request(`/api/v1/admin/comments/${receipt.data.receiptId}`, session, { method: 'PATCH', body: { status: 'approved', expectedVersion: 1 } });
    await request(`/api/v1/admin/comments/${receipt.data.receiptId}`, session, { method: 'PATCH', body: { status: 'hidden', expectedVersion: 2 } });
    projection = await store.get<StatisticsProjection>('system/statistics');
    expect(projection?.counts).toMatchObject({ creations: 2, commentsPending: 0 });
    const page = await statisticsRebuildPage(store, 'creations');
    expect(page).toMatchObject({ count: 2, scanned: 2, nextCursor: null });
    await expect(installStatisticsProjection(store, projection!.counts, 1, instant)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});

describe('release isolation and actual R2 conditional activation', () => {
  it('keeps draft and hidden photos out of the snapshot and its media allowlist', async () => {
    for (const id of ['asset_public', 'asset_draft', 'asset_hidden']) await seedAsset(id);
    const draft = AlbumDraftSchema.parse({ title: 'Test album', slug: 'test-album', photos: [
      { id: 'photo_public', assetId: 'asset_public', alt: 'Test public image', status: 'published' },
      { id: 'photo_draft', assetId: 'asset_draft', alt: 'Test draft image' },
      { id: 'photo_hidden', assetId: 'asset_hidden', alt: 'Test hidden image', status: 'hidden' },
    ] });
    const record = await api.records.save('albums', AlbumDraftSchema, draft, uid);
    const job = await finishBuild(await api.releases.create({ changes: [{ collection: 'albums', id: record.id, version: 1, action: 'publish' }], expectedReleaseId: null }, uid));
    const snapshot = await api.releases.snapshot(job.id);
    expect(snapshot.albums[0]?.photos.map(photo => photo.assetId)).toEqual(['asset_public']);
    expect(snapshot.assets.map(asset => asset.id)).toEqual(['asset_public']);
    expect(JSON.stringify(snapshot)).not.toContain('private-original');
    expect((await request('/api/v1/media/asset_public/content')).status).toBe(404);
    await api.releases.activate(job.id, null);
    const publicResponse = await request('/api/v1/media/asset_public/content');
    expect(publicResponse.status).toBe(200); expect(await publicResponse.text()).toBe('test-only-image-bytes');
    for (const path of ['/api/v1/media/asset_draft/content', '/api/v1/media/asset_hidden/content', '/api/v1/media/asset_public/original', '/originals/asset_public/source']) expect((await request(path)).status, path).toBe(404);
  });

  it('removes an entire hidden album and its unshared media at activation', async () => {
    await seedAsset('asset_only');
    const record = await api.records.save('albums', AlbumDraftSchema, { title: 'Test album', slug: 'test-album', photos: [{ id: 'photo', assetId: 'asset_only', alt: 'Test', status: 'published' }] }, uid);
    const published = await finishBuild(await api.releases.create({ changes: [{ collection: 'albums', id: record.id, version: 1, action: 'publish' }], expectedReleaseId: null }, uid));
    await api.releases.activate(published.id, null);
    const hidden = await finishBuild(await api.releases.create({ changes: [{ collection: 'albums', id: record.id, version: 1, action: 'hide' }], expectedReleaseId: published.id }, uid));
    expect((await request('/api/v1/media/asset_only/content')).status).toBe(200);
    await api.releases.activate(hidden.id, published.id);
    expect((await request('/api/v1/media/asset_only/content')).status).toBe(404);
    expect((await api.releases.snapshot(hidden.id)).albums).toEqual([]);
    expect((await bucket.head('variants/asset_only/content.webp'))?.size).toBeGreaterThan(0);
  });

  it('makes one of two competing releases active without mixing their snapshot or HTML', async () => {
    const first = await readyCreation('test release one'), second = await readyCreation('test release two');
    const outcomes = await Promise.allSettled([api.releases.activate(first.id, null), api.releases.activate(second.id, null)]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'RELEASE_CONFLICT', status: 409 });
    const active = await api.releases.active();
    const loser = active!.value.releaseId === first.id ? second : first;
    expect(['ready', 'superseded']).toContain((await api.releases.reconcile(loser.id)).status);
    const json = await (await request('/api/v1/creations')).json() as { data: Snapshot['creations']; meta: { releaseId: string } };
    expect(json.meta.releaseId).toBe(active!.value.releaseId);
    expect(json.data).toHaveLength(1);
    const html = await request('/');
    expect(html.headers.get('x-xvyin-release')).toBe(active!.value.releaseId);
    expect(await html.text()).toContain(active!.value.releaseId);
  });

  it('requires an admin session for preview cookies and marks preview media private', async () => {
    await seedAsset('asset_preview');
    const draft = creation('preview'); draft.coverAssetId = 'asset_preview';
    const record = await api.records.save('creations', CreationDraftSchema, draft, uid);
    const ready = await finishBuild(await api.releases.create({ changes: [{ collection: 'creations', id: record.id, version: 1, action: 'publish' }], expectedReleaseId: null }, uid));
    const cookie = `__Host-xvyin_preview=${ready.id}`;
    expect((await request('/api/v1/media/asset_preview/content', undefined, { headers: { cookie } })).status).toBe(401);
    const session = await login();
    const preview = await request('/api/v1/media/asset_preview/content', session, { headers: { cookie: `${session.cookie}; ${cookie}` } });
    expect(preview.status).toBe(200); expect(preview.headers.get('cache-control')).toBe('private, no-store');
    expect(preview.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('serves bounded media ranges and conditional requests without confusing a whole object with a partial response', async () => {
    await seedAsset('asset_range');
    const draft = creation('range test'); draft.coverAssetId = 'asset_range';
    const record = await api.records.save('creations', CreationDraftSchema, draft, uid);
    const ready = await finishBuild(await api.releases.create({ changes: [{ collection: 'creations', id: record.id, version: 1, action: 'publish' }], expectedReleaseId: null }, uid));
    await api.releases.activate(ready.id, null);
    const whole = await request('/api/v1/media/asset_range/content');
    expect(whole.status).toBe(200); expect(whole.headers.has('content-range')).toBe(false);
    const range = await request('/api/v1/media/asset_range/content', undefined, { headers: { range: 'bytes=2-5' } });
    expect(range.status).toBe(206); expect(range.headers.get('content-range')).toBe('bytes 2-5/21'); expect(await range.text()).toBe('st-o');
    const unchanged = await request('/api/v1/media/asset_range/content', undefined, { headers: { 'if-none-match': whole.headers.get('etag')! } });
    expect(unchanged.status).toBe(304); expect(await unchanged.text()).toBe('');
    const head = await request('/api/v1/media/asset_range/content', undefined, { method: 'HEAD' });
    expect(head.status).toBe(200); expect(head.headers.get('content-length')).toBe('21'); expect(await head.text()).toBe('');
    const matching = await request('/api/v1/media/asset_range/content', undefined, { headers: { range: 'bytes=2-5', 'if-range': whole.headers.get('etag')! } });
    expect(matching.status).toBe(206); expect(await matching.text()).toBe('st-o');
    const mismatched = await request('/api/v1/media/asset_range/content', undefined, { headers: { range: 'bytes=2-5', 'if-range': '"another-version"' } });
    expect(mismatched.status).toBe(200); expect(await mismatched.text()).toBe('test-only-image-bytes');
    for (const range of ['bytes=abc', 'bytes=0-2,5-7', 'bytes=100-200', 'bytes=21-', 'bytes=-0', 'bytes=5-2', 'bytes=9007199254740992-']) {
      const rejected = await request('/api/v1/media/asset_range/content', undefined, { headers: { range } });
      expect(rejected.status, range).toBe(416);
      if (range === 'bytes=100-200') expect(rejected.headers.get('content-range')).toBe('bytes */21');
    }
  });

  it('reconciles rollback visibility against the actual snapshot while preserving newer drafts', async () => {
    const first = await readyCreation('original test content'); await api.releases.activate(first.id, null);
    const secondDraft = creation('second test content'); secondDraft.slug = 'second-test-creation';
    const record = await api.records.save('creations', CreationDraftSchema, secondDraft, uid);
    const second = await finishBuild(await api.releases.create({ changes: [{ collection: 'creations', id: record.id, version: 1, action: 'publish' }], expectedReleaseId: first.id }, uid));
    await api.releases.activate(second.id, first.id);
    await api.records.save('creations', CreationDraftSchema, { ...secondDraft, title: 'newer unpublished edit' }, uid, record.id, 1);
    await api.releases.activate(first.id, second.id);
    const restored = await (await request('/api/v1/creations')).json() as { data: Snapshot['creations'] };
    expect(restored.data.map(value => value.id)).not.toContain(record.id);
    const session = await login();
    const detail = await (await request(`/api/v1/admin/creations/${record.id}`, session)).json() as { data: { visibility: string } };
    const list = await (await request('/api/v1/admin/creations', session)).json() as { data: Array<{ id: string; visibility: string }> };
    expect(detail.data.visibility).toBe('hidden');
    expect(list.data.find(item => item.id === record.id)?.visibility).toBe('hidden');
    const draft = await store.get<{ visibility: string; version: number; draft: { title: string } }>(`creations/${record.id}`);
    expect(draft?.version).toBe(2); expect(draft?.draft.title).toBe('newer unpublished edit');
  });
});

describe('actual upload parts and atomic capacity accounting', () => {
  it('accepts the exact decimal 512 MB declaration and rejects larger uploads before reserving', async () => {
    const upload = await api.media.start({ kind: 'video', originalName: 'test.mp4', expectedMime: 'video/mp4', expectedBytes: 512_000_000 }, uid);
    expect(upload.totalParts).toBe(Math.ceil(512_000_000 / PART_SIZE));
    expect(await api.media.quota()).toMatchObject({ reservedBytes: 512_000_000, limitBytes: 10_000_000_000 });
    await expect(api.media.start({ kind: 'video', originalName: 'test.mp4', expectedMime: 'video/mp4', expectedBytes: 512_000_001 }, uid)).rejects.toThrow();
    await api.media.abort(upload.uploadId, uid);
    expect(await api.media.quota()).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
  });

  it('prevents concurrent reservations from exceeding the total capacity', async () => {
    await store.transaction(async tx => { tx.put('system/media_quota', { usedBytes: MEDIA_LIMITS.totalBytes - 512_000_000, reservedBytes: 0, limitBytes: MEDIA_LIMITS.totalBytes }); });
    const input = { kind: 'video', originalName: 'test.mp4', expectedMime: 'video/mp4', expectedBytes: 512_000_000 };
    const attempts = await Promise.allSettled([api.media.start(input, uid), api.media.start(input, uid)]);
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
    expect((attempts.find(attempt => attempt.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'MEDIA_QUOTA_EXCEEDED' });
    expect(await api.media.quota()).toMatchObject({ reservedBytes: 512_000_000 });
    const accepted = attempts.find(attempt => attempt.status === 'fulfilled') as PromiseFulfilledResult<Upload>;
    await api.media.abort(accepted.value.uploadId, uid);
  });

  it('counts actual streamed bytes even when Content-Length lies, then completes an 8 MiB part and final tail', async () => {
    const upload = await api.media.start({ kind: 'video', originalName: 'test.webm', expectedMime: 'video/webm', expectedBytes: PART_SIZE + 7 }, uid);
    const partRequest = (bytes: number, declared = bytes) => new Request(`${origin}/part`, { method: 'PUT', headers: { 'content-length': String(declared) }, body: new Uint8Array(bytes) });
    await expect(api.media.part(upload.uploadId, 1, partRequest(PART_SIZE + 1, PART_SIZE), uid)).rejects.toMatchObject({ code: 'PART_SIZE_MISMATCH', status: 413 });
    await expect(api.media.part(upload.uploadId, 1, partRequest(PART_SIZE - 1, PART_SIZE), uid)).rejects.toMatchObject({ code: 'PART_SIZE_MISMATCH', status: 422 });
    expect((await api.media.get(upload.uploadId, uid)).parts).toEqual([]);
    await api.media.part(upload.uploadId, 1, partRequest(PART_SIZE), uid);
    await api.media.part(upload.uploadId, 2, partRequest(7), uid);
    const asset = await api.media.complete(upload.uploadId, uid);
    expect(asset).toMatchObject({ status: 'processing', variants: [], originalBytes: PART_SIZE + 7 });
    expect(await api.media.quota()).toMatchObject({ usedBytes: PART_SIZE + 7, reservedBytes: 0 });
    expect(await api.media.complete(upload.uploadId, uid)).toEqual(asset);
    expect(await api.media.quota()).toMatchObject({ usedBytes: PART_SIZE + 7, reservedBytes: 0 });
    expect((await request(`/api/v1/media/${asset.id}/original`)).status).toBe(404);
  });

  it('claims cancellation before touching R2 so new parts and completion cannot enter a cancelling upload', async () => {
    let enteredAbort!: () => void, releaseAbort!: () => void;
    const entered = new Promise<void>(resolve => { enteredAbort = resolve; });
    const release = new Promise<void>(resolve => { releaseAbort = resolve; });
    const delayed = new Proxy(bucket, { get(target, property) {
      if (property === 'resumeMultipartUpload') return (key: string, uploadId: string) => {
        const multipart = target.resumeMultipartUpload(key, uploadId);
        return { key, uploadId, uploadPart: multipart.uploadPart.bind(multipart), complete: multipart.complete.bind(multipart), abort: async () => { enteredAbort(); await release; return multipart.abort(); } };
      };
      const value: unknown = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const media = new Media(store, delayed, () => instant);
    const upload = await media.start({ kind: 'video', originalName: 'race.webm', expectedMime: 'video/webm', expectedBytes: 7 }, uid);
    await media.part(upload.uploadId, 1, new Request(`${origin}/part`, { method: 'PUT', body: new Uint8Array(7) }), uid);
    const aborted = media.abort(upload.uploadId, uid);
    await entered;
    let outcome: PromiseSettledResult<unknown>, completion: PromiseSettledResult<unknown>;
    try {
      [completion] = await Promise.allSettled([media.complete(upload.uploadId, uid)]);
      [outcome] = await Promise.allSettled([media.part(upload.uploadId, 1, new Request(`${origin}/part`, { method: 'PUT', body: new Uint8Array(7) }), uid)]);
    } finally { releaseAbort(); await aborted; }
    expect(outcome!.status).toBe('rejected'); expect(completion!.status).toBe('rejected');
    expect((await media.get(upload.uploadId, uid)).state).toBe('aborted');
    expect(await media.quota()).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    expect(await bucket.head(upload.key)).toBeNull();
  });

  it('refuses cancellation while a leased R2 part is in flight and preserves its eventual accounting', async () => {
    let enteredPart!: () => void, releasePart!: () => void;
    const entered = new Promise<void>(resolve => { enteredPart = resolve; });
    const release = new Promise<void>(resolve => { releasePart = resolve; });
    const delayed = new Proxy(bucket, { get(target, property) {
      if (property === 'resumeMultipartUpload') return (key: string, uploadId: string) => {
        const multipart = target.resumeMultipartUpload(key, uploadId);
        return { key, uploadId, abort: multipart.abort.bind(multipart), complete: multipart.complete.bind(multipart), uploadPart: async (...args: Parameters<R2MultipartUpload['uploadPart']>) => { enteredPart(); await release; return multipart.uploadPart(...args); } };
      };
      const value: unknown = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const media = new Media(store, delayed, () => instant);
    const upload = await media.start({ kind: 'video', originalName: 'race.webm', expectedMime: 'video/webm', expectedBytes: 7 }, uid);
    const pending = media.part(upload.uploadId, 1, new Request(`${origin}/part`, { method: 'PUT', body: new Uint8Array(7) }), uid);
    await entered;
    try { await expect(media.abort(upload.uploadId, uid)).rejects.toMatchObject({ code: 'PART_BUSY', status: 409 }); }
    finally { releasePart(); await pending; }
    expect((await media.get(upload.uploadId, uid)).state).toBe('uploading');
    await media.complete(upload.uploadId, uid);
    expect(await media.quota()).toMatchObject({ usedBytes: 7, reservedBytes: 0 });
  });
});
