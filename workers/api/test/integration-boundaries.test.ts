import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { AlbumDraftSchema, CreationDraftSchema, FitnessSettingsDraftSchema, HERO_TITLE, MEDIA_LIMITS, PlaylistDraftSchema, SiteSettingsSchema } from '@xvyin/contracts';
import { createApi, type Runtime } from '../src/app';
import { AuthError, type AuthProvider } from '../src/auth';
import worker from '../src/index';
import { installStatisticsProjection, statisticsRebuildPage, type DraftRecord, type StatisticsProjection } from '../src/records';
import { Media, PART_SIZE, type MediaAsset, type Upload } from '../src/media';
import { type ReleaseCandidate, type ReleaseJob, type Snapshot } from '../src/releases';
import { sha256 } from '../src/security';
import { MemoryStore } from '../src/store/memory';
import { type ManagedMedia, type PurgeJob } from '../src/media-library';

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
async function finishBuild(job: ReleaseJob, homeContent = `${HERO_TITLE} ${job.id} TEST CONTENT`): Promise<ReleaseJob> {
  const runId = `test-run-${job.id}`;
  let claimed = await api.releases.claim(job.id, runId, codeSha);
  for (let step = 0; claimed.snapshotPrepared === false && step < 100; step++) claimed = await api.releases.prepareSnapshot(job.id, runId);
  expect(claimed.snapshotPrepared).not.toBe(false);
  const snapshot = await api.releases.snapshot(job.id);
  const paths = ['/', '/about/', '/creations/', '/photography/', '/fitness/', '/guestbook/', '/contact/', ...snapshot.creations.map(value => `/creations/${value.slug}/`), ...snapshot.albums.map(value => `/photography/${value.slug}/`)];
  const html = `<!doctype html><html><body>${homeContent}</body></html>`;
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

describe('explicit rebuilding of published content', () => {
  it('projects verified photography details into the public snapshot without original storage information', async () => {
    const asset = await seedAsset('camera-photo');
    const photography = { cameraMake: 'Sony', cameraModel: 'ILCE-7RM5', aperture: 2.8, takenDate: '2024-02-29', takenAt: '2024-02-29T10:00:00' };
    await store.transaction(async tx => { tx.put(`media/${asset.id}`, { ...asset, metadata: { kind: 'image', detectedMime: 'image/jpeg', bytes: 16, sha256: 'b'.repeat(64), width: 8000, height: 6000, photography } }); });
    const record = await api.records.save('creations', CreationDraftSchema, { ...creation('Camera image'), coverAssetId: asset.id }, uid);
    const job = await finishBuild(await api.releases.create({ changes: [{ collection: 'creations', id: record.id, version: 1, action: 'publish' }], expectedReleaseId: null }, uid));
    const snapshot = await api.releases.snapshot(job.id);
    expect(snapshot.assets[0]?.photography).toEqual(photography);
    expect(snapshot.assets[0]).not.toHaveProperty('originalKey'); expect(snapshot.assets[0]).not.toHaveProperty('originalName');
  });

  it('rejects empty ordinary releases, mixed draft rebuilds and a rebuild with no public base', async () => {
    const session = await login();
    for (const body of [
      { changes: [], expectedReleaseId: null },
      { changes: [{ collection: 'creations', id: 'local-only', version: 1, action: 'publish' }], expectedReleaseId: null, rebuildPublished: true },
    ]) expect((await request('/api/v1/admin/releases', session, { method: 'POST', body })).status).toBe(422);
    const unavailable = await request('/api/v1/admin/releases', session, { method: 'POST', body: { changes: [], expectedReleaseId: null, rebuildPublished: true } });
    expect(unavailable.status).toBe(409);
    expect((await unavailable.json() as { error: { code: string } }).error.code).toBe('REBUILD_REQUIRES_PUBLISHED');
    expect((await store.list('releases')).items).toEqual([]);
  });

  it('freezes only the active snapshot through build and activation while all unpublished edits remain untouched', async () => {
    await seedAsset('published-image');
    const record = await api.records.save('creations', CreationDraftSchema, { ...creation('Published title'), coverAssetId: 'published-image' }, uid);
    const initial = await finishBuild(await api.releases.create({ changes: [{ collection: 'creations', id: record.id, version: 1, action: 'publish' }], expectedReleaseId: null }, uid));
    await api.releases.activate(initial.id, null);
    const published = await api.releases.snapshot(initial.id);
    await api.records.save('creations', CreationDraftSchema, { title: 'PRIVATE INCOMPLETE EDIT', blocks: [{ id: 'pending', type: 'image', assetId: '' }] }, uid, record.id, 1);
    await api.records.save('creations', CreationDraftSchema, { title: 'PRIVATE NEW DRAFT' }, uid);
    await api.records.save('settings', SiteSettingsSchema, { intro: 'PRIVATE SETTINGS' }, uid, 'site');
    await api.records.save('settings', FitnessSettingsDraftSchema, { startDate: null }, uid, 'fitness');
    await api.records.save('playlists', PlaylistDraftSchema, { name: 'PRIVATE PLAYLIST' }, uid);
    const collections = ['creations', 'settings', 'playlists'];
    const drafts = await Promise.all(collections.map(collection => store.list(collection)));
    const reads = vi.spyOn(store, 'getMany');
    const session = await login(), input = { changes: [], expectedReleaseId: initial.id, rebuildPublished: true }, key = crypto.randomUUID();
    const created = await request('/api/v1/admin/releases', session, { method: 'POST', body: input, headers: { 'idempotency-key': key } });
    expect(created.status).toBe(201);
    const job = (await created.json() as { data: ReleaseJob }).data;
    expect(job).toMatchObject({ changes: [], rebuildPublished: true, previousReleaseId: initial.id, selectedRevisionIds: {}, snapshotPrepared: true });
    expect(reads.mock.calls).toEqual([[['media/published-image']]]); reads.mockRestore();
    expect(await api.releases.snapshot(job.id)).toEqual({ ...published, releaseId: job.id });
    expect(await api.releases.create(input, uid, key)).toMatchObject({ id: job.id });
    const ready = await finishBuild(job);
    expect(await api.releases.activate(ready.id, initial.id)).toMatchObject({ status: 'live', reconciledRecords: 0, reconciliationPending: false });
    expect(await api.releases.snapshot(ready.id)).toEqual({ ...published, releaseId: ready.id });
    expect(await Promise.all(collections.map(collection => store.list(collection)))).toEqual(drafts);
    expect(await (await request('/api/v1/creations')).text()).toContain('Published title');
    expect(await (await request('/api/v1/creations')).text()).not.toContain('PRIVATE');
    await expect(api.releases.create(input, uid)).rejects.toMatchObject({ code: 'RELEASE_CONFLICT' });
  });

  it('rebuilds a previously published photo with backfilled EXIF without republishing the content draft', async () => {
    const asset = await seedAsset('legacy-camera-image');
    const record = await api.records.save('creations', CreationDraftSchema, { ...creation('Original public title'), coverAssetId: asset.id }, uid);
    const initial = await finishBuild(await api.releases.create({ changes: [{ collection: 'creations', id: record.id, version: 1, action: 'publish' }], expectedReleaseId: null }, uid));
    await api.releases.activate(initial.id, null);
    const before = await api.releases.snapshot(initial.id), photography = { cameraMake: 'Canon', cameraModel: 'EOS R5', aperture: 4, iso: 200, takenDate: '2024-02-29' };
    expect(before.assets[0]).not.toHaveProperty('photography');
    await store.transaction(async tx => { tx.put(`media/${asset.id}`, { ...asset, metadata: { kind: 'image', detectedMime: 'image/jpeg', bytes: 16, sha256: 'b'.repeat(64), width: 8000, height: 6000, photography } }); });
    await api.records.save('creations', CreationDraftSchema, { title: 'PRIVATE LATER DRAFT' }, uid, record.id, 1);
    const candidate = await api.releases.create({ changes: [], expectedReleaseId: initial.id, rebuildPublished: true }, uid);
    const rebuilt = await api.releases.snapshot(candidate.id);
    expect(rebuilt).toEqual({ ...before, releaseId: candidate.id, assets: before.assets.map(value => ({ ...value, photography })) });
    expect(rebuilt.creations[0]).toMatchObject({ title: 'Original public title', revisionId: record.draftRevisionId, publishedAt: before.creations[0]!.publishedAt });
    const ready = await finishBuild(candidate); await api.releases.activate(ready.id, initial.id);
    expect((await api.releases.snapshot(ready.id)).assets[0]!.photography).toEqual(photography);
    expect(await api.releases.snapshot(initial.id)).toEqual(before);
    expect(await store.get(`creations/${record.id}`)).toMatchObject({ version: 2, draft: { title: 'PRIVATE LATER DRAFT' } });
  });
});

describe('private media management HTTP boundaries', () => {
  it('requires authentication on reads and valid same-origin CSRF on every new mutation route', async () => {
    for (const path of ['media', 'media/catalog', 'media/duplicates', 'media/purge-jobs/local-check']) expect((await request(`/api/v1/admin/${path}`)).status).toBe(401);
    const session = await login();
    const mutations = [
      { path: 'media/catalog/advance', method: 'POST' }, { path: 'media/local-image', method: 'PATCH' },
      ...['trash', 'restore', 'purge-check'].map(action => ({ path: `media/local-image/${action}`, method: 'POST' })),
      ...['advance', 'confirm', 'cancel'].map(action => ({ path: `media/purge-jobs/local-check/${action}`, method: 'POST' })),
    ];
    for (const mutation of mutations) {
      const path = `/api/v1/admin/${mutation.path}`;
      expect((await request(path, session, { method: mutation.method, body: {}, headers: { 'x-csrf-token': '' } })).status).toBe(403);
      expect((await request(path, session, { method: mutation.method, body: {}, headers: { origin: 'https://attacker.invalid' } })).status).toBe(403);
    }
    expect(await store.get('system/media_catalog')).toBeNull();
    expect((await store.list('media_purge_jobs')).items).toEqual([]);
  });

  it('reports an unfinished legacy catalog and backfills small pages before serving old media', async () => {
    const fixture = await seedAsset('legacy-template');
    store = new MemoryStore(Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`media/legacy-${index}`, { ...fixture, id: `legacy-${index}`, originalName: `legacy-${index}.jpg` }])));
    api = createApi({ store, bucket, auth, now: () => instant, secureCookies: true, allowedOrigins: [origin], privacySalt: 'local-test-salt'.repeat(4), adminUsername: 'test-admin', codeSha });
    const session = await login();
    expect(await (await request('/api/v1/admin/media', session)).json()).toMatchObject({ data: [], meta: { catalogReady: false, nextCursor: null } });
    expect(await (await request('/api/v1/admin/media/catalog/advance', session, { method: 'POST', body: {} })).json()).toMatchObject({ data: { ready: false, processed: 5 } });
    expect(await (await request('/api/v1/admin/media/catalog/advance', session, { method: 'POST', body: {} })).json()).toMatchObject({ data: { ready: true, processed: 7 } });
    const loaded = await (await request('/api/v1/admin/media?sort=name&direction=asc', session)).json() as { data: ManagedMedia[]; meta: { catalogReady: boolean } };
    expect(loaded.meta.catalogReady).toBe(true); expect(loaded.data.map(item => item.id)).toEqual(Array.from({ length: 7 }, (_, index) => `legacy-${index}`));
  });

  it('applies server ordering and combined filters beyond the first 50 assets with a bound query cursor', async () => {
    const fixture = await seedAsset('catalog-template'), session = await login();
    await store.transaction(async tx => {
      tx.delete('media/catalog-template');
      for (let index = 0; index < 70; index++) {
        const id = `http-${String(index).padStart(3, '0')}`;
        tx.put(`media/${id}`, { ...fixture, id, originalName: `${String(index).padStart(3, '0')}-session.jpg`, category: index >= 60 ? 'fitness' : 'photography' });
      }
      tx.put('system/media_catalog', { ready: true, processed: 70, cursor: null, version: 1 });
    });
    const query = '/api/v1/admin/media?sort=name&direction=asc&category=fitness&kind=image&status=ready&q=session&limit=24';
    const first = await (await request(query, session)).json() as { data: ManagedMedia[]; meta: { nextCursor: string; scanned: number } };
    expect(first.data).toEqual([]); expect(first.meta.scanned).toBe(48); expect(first.meta.nextCursor).toBeTruthy();
    const second = await (await request(`${query}&cursor=${encodeURIComponent(first.meta.nextCursor)}`, session)).json() as { data: ManagedMedia[]; meta: { nextCursor: null } };
    expect(second.data.map(item => item.id)).toEqual(Array.from({ length: 10 }, (_, index) => `http-${String(60 + index).padStart(3, '0')}`));
    expect(second.meta.nextCursor).toBeNull();
    expect((await request(`${query.replace('category=fitness', 'category=photography')}&cursor=${encodeURIComponent(first.meta.nextCursor)}`, session)).status).toBe(422);
  });

  it('keeps storage keys out of every purge response and blocks private reads once physical cleanup is confirmed', async () => {
    const asset = await seedAsset('purge-http'), session = await login();
    await store.transaction(async tx => { tx.put('system/media_quota', { usedBytes: asset.originalBytes + asset.variants[0]!.bytes, reservedBytes: 0, limitBytes: MEDIA_LIMITS.totalBytes }); });
    const trash = await request(`/api/v1/admin/media/${asset.id}/trash`, session, { method: 'POST', body: { expectedVersion: 1 } }); expect(trash.status).toBe(200);
    type PublicPurge = Omit<PurgeJob, 'keys'> & { totalKeys: number };
    const dto = async (response: Response): Promise<PublicPurge> => {
      expect(response.ok).toBe(true);
      const body = await response.json() as { data: PublicPurge };
      expect(body.data).not.toHaveProperty('keys'); expect(body.data.totalKeys).toBe(2);
      expect(JSON.stringify(body)).not.toContain('originals/'); expect(JSON.stringify(body)).not.toContain('variants/');
      return body.data;
    };
    let job = await dto(await request(`/api/v1/admin/media/${asset.id}/purge-check`, session, { method: 'POST', body: { expectedVersion: 2 }, headers: { 'idempotency-key': crypto.randomUUID() } }));
    const path = `/api/v1/admin/media/purge-jobs/${job.id}`;
    await dto(await request(path, session));
    for (let step = 0; job.status === 'checking' && step < 20; step++) job = await dto(await request(`${path}/advance`, session, { method: 'POST', body: {} }));
    expect(job.status).toBe('ready'); expect(await bucket.head(asset.originalKey)).not.toBeNull();
    job = await dto(await request(`${path}/confirm`, session, { method: 'POST', body: {} })); expect(job.status).toBe('deleting');
    for (const suffix of ['', '/content']) expect((await request(`/api/v1/admin/media/${asset.id}${suffix}`, session)).status).toBe(404);
    for (let step = 0; job.status === 'deleting' && step < 3; step++) job = await dto(await request(`${path}/advance`, session, { method: 'POST', body: {} }));
    expect(job.status).toBe('deleted'); await dto(await request(path, session));
    expect(await store.get('system/media_quota')).toMatchObject({ usedBytes: 0 });
    expect((await request(`/api/v1/admin/media/${asset.id}/restore`, session, { method: 'POST', body: { expectedVersion: 4 } })).status).toBe(409);
  });

  it('rejects mutation field injection and clears a cancelled check so the same media can be checked afresh', async () => {
    const asset = await seedAsset('cancel-http'), session = await login();
    const rejected = await request(`/api/v1/admin/media/${asset.id}`, session, { method: 'PATCH', body: { expectedVersion: 1, category: 'fitness', lifecycle: 'deleted' } }); expect(rejected.status).toBe(422);
    expect(await store.get(`media/${asset.id}`)).toEqual(asset);
    await request(`/api/v1/admin/media/${asset.id}/trash`, session, { method: 'POST', body: { expectedVersion: 1 } });
    const begin = async () => (await (await request(`/api/v1/admin/media/${asset.id}/purge-check`, session, { method: 'POST', body: { expectedVersion: 2 }, headers: { 'idempotency-key': crypto.randomUUID() } })).json() as { data: Omit<PurgeJob, 'keys'> }).data;
    const old = await begin();
    const cancelled = await (await request(`/api/v1/admin/media/purge-jobs/${old.id}/cancel`, session, { method: 'POST', body: {} })).json() as { data: Omit<PurgeJob, 'keys'> };
    expect(cancelled.data.status).toBe('cancelled'); expect(cancelled.data).not.toHaveProperty('keys');
    expect(await store.get(`media/${asset.id}`)).not.toHaveProperty('purgeJobId');
    const fresh = await begin(); expect(fresh.id).not.toBe(old.id); expect(fresh.status).toBe('checking');
  });
});

describe('HTTP authentication, moderation and optimistic updates', () => {
  it('persists and reloads incomplete drafts in every collection, but identifies missing fields before any candidate exists', async () => {
    const session = await login();
    const drafts = {
      creations: { title: 'Incomplete mixed media', blocks: [{ id: 'image', type: 'image' }, { id: 'audio', type: 'audio', title: '' }, { id: 'video', type: 'video', assetId: '' }] },
      albums: { title: 'Incomplete photo essay', photos: [{ id: 'photo', assetId: '', alt: '', status: 'published' }] },
      fitness: { title: 'Incomplete fitness record', entryDate: '', photos: [] },
      playlists: { name: '', source: 'tencent', sourceId: '', tracks: [{ id: 'track', title: '', providerRef: { provider: 'tencent', contentId: '' } }] },
    };
    for (const [collection, draft] of Object.entries(drafts)) {
      const saved = await request(`/api/v1/admin/${collection}`, session, { method: 'POST', body: { draft } });
      expect(saved.status).toBe(201);
      const record = (await saved.json() as { data: DraftRecord }).data;
      const loaded = await request(`/api/v1/admin/${collection}/${record.id}`, session);
      expect(loaded.status).toBe(200);
      expect((await loaded.json() as { data: DraftRecord }).data).toEqual(record);
      const failed = await request('/api/v1/admin/releases', session, { method: 'POST', body: { changes: [{ collection, id: record.id, version: 1, action: 'publish' }], expectedReleaseId: null } });
      expect(failed.status).toBe(422);
      const error = (await failed.json() as { error: { code: string; message: string; fields: Record<string, string[]> } }).error;
      expect(error.code).toBe('PUBLISH_VALIDATION'); expect(error.message).toContain('草稿已保留');
      expect(Object.keys(error.fields).length).toBeGreaterThan(0);
      expect(await store.get(`${collection}/${record.id}`)).toEqual(record);
    }
    expect((await store.list('releases')).items).toHaveLength(0);
    expect(await bucket.get('active-release.json')).toBeNull();
  });

  it('requires an explicit photo selection and keeps unfinished private photos out of the public snapshot', async () => {
    const session = await login(); await seedAsset('photo-visible');
    const draft = { title: 'Fitness photo selection test', entryDate: '2026-09-12', photos: [
      { id: 'visible', assetId: 'photo-visible', alt: 'Synthetic test photo', status: 'draft' },
      { id: 'unfinished', assetId: '', alt: '', status: 'draft' },
      { id: 'hidden', assetId: '', alt: '', status: 'hidden' },
    ] };
    const saved = await request('/api/v1/admin/fitness', session, { method: 'POST', body: { draft } });
    expect(saved.status).toBe(201);
    const record = (await saved.json() as { data: DraftRecord }).data;
    const rejected = await request('/api/v1/admin/releases', session, { method: 'POST', body: { changes: [{ collection: 'fitness', id: record.id, version: 1, action: 'publish' }], expectedReleaseId: null } });
    expect(rejected.status).toBe(422);
    expect(JSON.stringify(await rejected.json())).toContain('随本条记录发布');
    draft.photos[0]!.status = 'published';
    const changed = await request(`/api/v1/admin/fitness/${record.id}`, session, { method: 'PATCH', body: { draft, expectedVersion: 1 } });
    expect(changed.status).toBe(200);
    const created = await request('/api/v1/admin/releases', session, { method: 'POST', body: { changes: [{ collection: 'fitness', id: record.id, version: 2, action: 'publish' }], expectedReleaseId: null } });
    expect(created.status).toBe(201);
    const job = (await created.json() as { data: ReleaseJob }).data;
    const snapshot = await api.releases.snapshot(job.id);
    expect(snapshot.fitness.entries[0]?.photos.map(photo => photo.id)).toEqual(['visible']);
    expect(snapshot.assets.map(asset => asset.id)).toEqual(['photo-visible']);
    expect(await store.get(`fitness/${record.id}`)).toMatchObject({ version: 2, draft: { photos: expect.arrayContaining([{ ...draft.photos[1], photoDate: null, caption: '', sortOrder: 0, featured: false }]) } });
    expect(await bucket.get('active-release.json')).toBeNull();
  });

  it('normalizes the legacy title on admin reads without changing the saved revision', async () => {
    const session = await login();
    const record = await api.records.save('settings', SiteSettingsSchema, { intro: 'Existing introduction' }, uid, 'site');
    const legacy = { ...record, draft: { ...record.draft as Record<string, unknown>, heroTitle: 'hello！i‘m 虚宁' } };
    await store.transaction(async tx => { tx.put('settings/site', legacy); });
    const response = await request('/api/v1/admin/settings/site', session);
    expect(response.status).toBe(200);
    const { data } = await response.json() as { data: DraftRecord };
    expect(data).toMatchObject({ version: record.version, draftRevisionId: record.draftRevisionId, draft: { heroTitle: HERO_TITLE, intro: 'Existing introduction' } });
    expect(await store.get('settings/site')).toEqual(legacy);
    const saved = await request('/api/v1/admin/settings/site', session, { method: 'PATCH', body: { draft: data.draft, expectedVersion: data.version } });
    expect(saved.status).toBe(200);
    expect(await store.get('settings/site')).toMatchObject({ version: record.version + 1, draft: { heroTitle: HERO_TITLE } });
  });

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
    const pending: Promise<unknown>[] = [];
    vi.stubGlobal('caches', await mf.getCaches());
    try {
      const context: Parameters<typeof worker.fetch>[2] = {
        waitUntil(promise) { pending.push(promise); }, passThroughOnException() {}, props: {},
        get exports(): never { throw new Error('Unexpected test execution-context exports access'); },
        get tracing(): never { throw new Error('Unexpected test execution-context tracing access'); },
        abort(reason): never { throw reason; },
      };
      const response = await worker.fetch(new Request(`${origin}/`) as Parameters<typeof worker.fetch>[0], env, context);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(ready.id);
      await Promise.all(pending);
    } finally { vi.unstubAllGlobals(); }
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

describe('published homepage title integrity', () => {
  it.each(['old title', 'missing name', 'missing release'])('rejects %s after validating uploaded file hashes', async defect => {
    const record = await api.records.save('creations', CreationDraftSchema, creation('Title integrity fixture'), uid);
    const job = await api.releases.create({ changes: [{ collection: 'creations', id: record.id, version: record.version, action: 'publish' }], expectedReleaseId: null }, uid);
    const html = defect === 'old title' ? `hello！i‘m 虚宁 ${job.id}` : defect === 'missing name' ? `Hello! I am ${job.id}` : HERO_TITLE;
    await expect(finishBuild(job, html)).rejects.toMatchObject({ code: 'BUILD_HTML_INVALID' });
    expect((await api.releases.get(job.id)).status).toBe('building');
    expect(await api.releases.active()).toBeNull();
  });
});

describe('release isolation and actual R2 conditional activation', () => {
  it('lists saved candidates against the actual public snapshot despite an active private preview', async () => {
    const session = await login();
    const original = await api.records.save('creations', CreationDraftSchema, creation('Public original'), uid, 'original');
    const hidden = await api.records.save('creations', CreationDraftSchema, { ...creation('Hidden original'), slug: 'hidden-original' }, uid, 'hidden');
    const first = await finishBuild(await api.releases.create({ changes: [original, hidden].map(record => ({ collection: 'creations', id: record.id, version: 1, action: 'publish' })), expectedReleaseId: null }, uid));
    await api.releases.activate(first.id, null);
    const second = await finishBuild(await api.releases.create({ changes: [{ collection: 'creations', id: hidden.id, version: 1, action: 'hide' }], expectedReleaseId: first.id }, uid));
    await api.releases.activate(second.id, first.id);
    const edited = await api.records.save('creations', CreationDraftSchema, creation('New private title'), uid, original.id, 1);
    await api.records.save('creations', CreationDraftSchema, { ...creation('Unpublished'), slug: 'unpublished' }, uid, 'new');
    const preview = await finishBuild(await api.releases.create({ changes: [{ collection: 'creations', id: edited.id, version: 2, action: 'publish' }], expectedReleaseId: second.id }, uid));
    const result = await request(`/api/v1/admin/release-changes?collection=creations&expectedReleaseId=${second.id}`, session, { headers: { cookie: `${session.cookie}; __Host-xvyin_preview=${preview.id}` } });
    expect(result.status).toBe(200);
    const body = await result.json() as { data: ReleaseCandidate[]; meta: { activeReleaseId: string; nextCursor: string | null } };
    expect(body.meta).toMatchObject({ activeReleaseId: second.id, nextCursor: null });
    expect(body.data.find(item => item.id === original.id)).toMatchObject({ title: 'New private title', changeKind: 'modified', version: 2, draftRevisionId: edited.draftRevisionId, publishedRevisionId: original.draftRevisionId, actions: ['publish', 'hide'] });
    expect(body.data.find(item => item.id === hidden.id)).toMatchObject({ changeKind: 'hidden', publishedRevisionId: null, actions: ['publish'] });
    expect(body.data.find(item => item.id === 'new')).toMatchObject({ changeKind: 'new', actions: ['publish'] });
    expect(JSON.stringify(body)).not.toContain('Explicit integration test content');
    expect((await request(`/api/v1/admin/release-changes?collection=creations&expectedReleaseId=${first.id}`, session)).status).toBe(409);
    expect((await request('/api/v1/admin/release-changes?collection=creations')).status).toBe(401);
  });

  it('paginates beyond 50 records without dropping candidates and excludes never-saved settings', async () => {
    const session = await login();
    for (let index = 0; index < 53; index++) await api.records.save('creations', CreationDraftSchema, { ...creation(`Candidate ${index}`), slug: `candidate-${index}` }, uid, `candidate-${String(index).padStart(3, '0')}`);
    const first = await (await request('/api/v1/admin/release-changes?collection=creations&expectedReleaseId=unpublished', session)).json() as { data: ReleaseCandidate[]; meta: { nextCursor: string; activeReleaseId: null } };
    expect(first.data).toHaveLength(50); expect(first.meta.activeReleaseId).toBeNull(); expect(first.meta.nextCursor).toBeTruthy();
    const second = await (await request(`/api/v1/admin/release-changes?collection=creations&expectedReleaseId=unpublished&cursor=${first.meta.nextCursor}`, session)).json() as { data: ReleaseCandidate[]; meta: { nextCursor: null } };
    expect(second.data).toHaveLength(3); expect(second.meta.nextCursor).toBeNull();
    expect(new Set([...first.data, ...second.data].map(item => item.id)).size).toBe(53);
    expect((await (await request('/api/v1/admin/release-changes?collection=settings', session)).json() as { data: unknown[] }).data).toEqual([]);
    expect((await request(`/api/v1/admin/release-changes?collection=settings&cursor=${first.meta.nextCursor}`, session)).status).toBe(422);
  });

  it('compares normalized settings content instead of stale reconciliation metadata', async () => {
    const session = await login();
    const record = await api.records.save('settings', SiteSettingsSchema, { intro: 'Current introduction' }, uid, 'site');
    const first = await finishBuild(await api.releases.create({ changes: [{ collection: 'settings', id: 'site', version: 1, action: 'publish' }], expectedReleaseId: null }, uid));
    await api.releases.activate(first.id, null);
    await api.records.save('settings', SiteSettingsSchema, record.draft, uid, 'site', 1);
    let body = await (await request(`/api/v1/admin/release-changes?collection=settings&expectedReleaseId=${first.id}`, session)).json() as { data: ReleaseCandidate[] };
    expect(body.data[0]).toMatchObject({ id: 'site', version: 2, changeKind: 'unchanged', publishedRevisionId: null, actions: ['publish'] });
    await api.records.save('settings', SiteSettingsSchema, { ...record.draft, intro: 'Saved modification' }, uid, 'site', 2);
    await api.records.save('settings', FitnessSettingsDraftSchema, { startDate: null }, uid, 'fitness');
    body = await (await request('/api/v1/admin/release-changes?collection=settings', session)).json() as { data: ReleaseCandidate[] };
    expect(body.data.find(item => item.id === 'site')?.changeKind).toBe('modified');
    expect(body.data.find(item => item.id === 'fitness')?.changeKind).toBe('unchanged');
  });

  it('rejects an old ready candidate after another release wins, while allowing explicit restoration of a previously live version', async () => {
    const first = await readyCreation('Original'); await api.releases.activate(first.id, null);
    const record = await api.records.save('creations', CreationDraftSchema, { ...creation('New item'), slug: 'new-item' }, uid);
    const input = { changes: [{ collection: 'creations', id: record.id, version: 1, action: 'publish' }], expectedReleaseId: first.id };
    const candidate = await finishBuild(await api.releases.create(input, uid));
    const winner = await finishBuild(await api.releases.create(input, uid)); await api.releases.activate(winner.id, first.id);
    await expect(api.releases.activate(candidate.id, winner.id)).rejects.toMatchObject({ code: 'RELEASE_BASE_CHANGED', status: 409 });
    expect((await api.releases.active())?.value.releaseId).toBe(winner.id);
    expect((await api.releases.activate(first.id, winner.id)).status).toBe('live');
  });

  it('publishes 50 selected records atomically, keeps another draft private, and completes metadata in ten-record requests', async () => {
    const changes: ReleaseJob['changes'] = [];
    for (let index = 0; index < 50; index++) {
      const record = await api.records.save('creations', CreationDraftSchema, { ...creation(`Batch ${index}`), slug: `batch-${index}` }, uid);
      changes.push({ collection: 'creations', id: record.id, version: 1, action: 'publish' });
    }
    const privateDraft = await api.records.save('creations', CreationDraftSchema, { ...creation('Do not publish'), slug: 'private-draft' }, uid);
    await expect(api.releases.create({ changes: [...changes, { collection: 'creations', id: privateDraft.id, version: 1, action: 'publish' }], expectedReleaseId: null }, uid)).rejects.toThrow();
    const ready = await finishBuild(await api.releases.create({ changes, expectedReleaseId: null }, uid));
    let job = await api.releases.activate(ready.id, null);
    expect(job).toMatchObject({ status: 'live', reconciledRecords: 10, reconciliationPending: true });
    expect((await api.releases.snapshot(ready.id)).creations).toHaveLength(50);
    expect((await api.releases.snapshot(ready.id)).creations.some(item => item.id === privateDraft.id)).toBe(false);
    const session = await login();
    for (let count = 20; count <= 50; count += 10) {
      job = (await (await request(`/api/v1/admin/releases/${ready.id}`, session)).json() as { data: ReleaseJob }).data;
      expect(job).toMatchObject({ reconciledRecords: count, reconciliationPending: count < 50 });
    }
    for (const change of changes) expect(await store.get<DraftRecord>(`creations/${change.id}`)).toMatchObject({ visibility: 'published', lastPublishedRevisionId: job.selectedRevisionIds[`creations/${change.id}`] });
    expect((await store.get<DraftRecord>(`creations/${privateDraft.id}`))?.visibility).toBe('draft');
  });

  it('switches the default playlist by publishing both related edits in one candidate', async () => {
    const firstList = await api.records.save('playlists', PlaylistDraftSchema, { name: 'First test playlist', source: 'local', isDefault: true }, uid);
    const secondList = await api.records.save('playlists', PlaylistDraftSchema, { name: 'Second test playlist', source: 'local' }, uid);
    const initial = await finishBuild(await api.releases.create({ changes: [firstList, secondList].map(record => ({ collection: 'playlists', id: record.id, version: 1, action: 'publish' })), expectedReleaseId: null }, uid));
    await api.releases.activate(initial.id, null);
    await api.records.save('playlists', PlaylistDraftSchema, { ...firstList.draft, isDefault: false }, uid, firstList.id, 1);
    await api.records.save('playlists', PlaylistDraftSchema, { ...secondList.draft, isDefault: true }, uid, secondList.id, 1);
    await expect(api.releases.create({ changes: [{ collection: 'playlists', id: secondList.id, version: 2, action: 'publish' }], expectedReleaseId: initial.id }, uid)).rejects.toMatchObject({ code: 'DEFAULT_PLAYLIST_CONFLICT' });
    const candidate = await finishBuild(await api.releases.create({ changes: [firstList, secondList].map(record => ({ collection: 'playlists', id: record.id, version: 2, action: 'publish' })), expectedReleaseId: initial.id }, uid));
    expect((await api.releases.snapshot(initial.id)).playlists.find(item => item.isDefault)?.id).toBe(firstList.id);
    expect((await api.releases.active())?.value.releaseId).toBe(initial.id);
    await api.releases.activate(candidate.id, initial.id);
    expect((await api.releases.snapshot(candidate.id)).playlists.filter(item => item.isDefault).map(item => item.id)).toEqual([secondList.id]);
  });

  it('keeps hidden batch entries out of new drafts before their metadata synchronization finishes', async () => {
    const changes: ReleaseJob['changes'] = [];
    for (let index = 0; index < 12; index++) {
      const record = await api.records.save('creations', CreationDraftSchema, { ...creation(`Batch ${index}`), slug: `batch-${index}` }, uid);
      changes.push({ collection: 'creations', id: record.id, version: 1, action: 'publish' });
    }
    const first = await finishBuild(await api.releases.create({ changes, expectedReleaseId: null }, uid));
    expect((await api.releases.activate(first.id, null)).reconciliationPending).toBe(true);
    const hidden = await finishBuild(await api.releases.create({ changes: changes.map(change => ({ ...change, action: 'hide' })), expectedReleaseId: first.id }, uid));
    expect((await api.releases.activate(hidden.id, first.id)).reconciliationPending).toBe(true);
    const page = await api.releases.changesPage('creations');
    expect(page.items).toHaveLength(12); expect(page.items.every(item => item.changeKind === 'hidden')).toBe(true);
  });

  it('reuses one candidate and retries an unconfirmed build dispatch with the same idempotency key', async () => {
    const dispatchBuild = vi.fn().mockRejectedValueOnce(new Error('private transport detail')).mockRejectedValueOnce(new Error('second private transport detail')).mockResolvedValue(undefined);
    api = createApi({ store, bucket, auth, now: () => instant, secureCookies: true, allowedOrigins: [origin], privacySalt: 'test-only-salt-'.repeat(4), adminUsername: 'test-admin', codeSha, dispatchBuild });
    const session = await login(), record = await api.records.save('creations', CreationDraftSchema, creation('Idempotent draft'), uid);
    const body = { changes: [{ collection: 'creations', id: record.id, version: 1, action: 'publish' }], expectedReleaseId: null }, headers = { 'idempotency-key': crypto.randomUUID() };
    const first = await request('/api/v1/admin/releases', session, { method: 'POST', headers, body });
    expect(first.status).toBe(201); const job = (await first.json() as { data: ReleaseJob }).data;
    expect(job.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    expect(job).toMatchObject({ status: 'queued', dispatchState: 'unconfirmed', error: { code: 'BUILD_DISPATCH_UNCONFIRMED' } });
    const retried = (await (await request('/api/v1/admin/releases', session, { method: 'POST', headers, body })).json() as { data: ReleaseJob }).data;
    expect(retried).toMatchObject({ id: job.id, dispatchState: 'unconfirmed' });
    const second = (await (await request(`/api/v1/admin/releases/${job.id}/retry`, session, { method: 'POST', body: {} })).json() as { data: ReleaseJob }).data;
    expect(second).toMatchObject({ id: job.id, dispatchState: 'confirmed' }); expect(second.error).toBeUndefined();
    await request('/api/v1/admin/releases', session, { method: 'POST', headers, body }); expect(dispatchBuild).toHaveBeenCalledTimes(3);
    expect((await store.list('releases', { limit: 50 })).items).toHaveLength(1);
    expect((await request('/api/v1/admin/releases', session, { method: 'POST', headers, body: { ...body, changes: [{ ...body.changes[0], action: 'hide' }] } })).status).toBe(409);
    await finishBuild(second);
    expect((await request(`/api/v1/admin/releases/${job.id}/retry`, session, { method: 'POST', body: {} })).status).toBe(409);
  });

  it('rejects dispatch retries after either the code or public baseline changes', async () => {
    const record = await api.records.save('creations', CreationDraftSchema, creation('Queued candidate'), uid);
    const input = { changes: [{ collection: 'creations', id: record.id, version: 1, action: 'publish' }], expectedReleaseId: null };
    const old = await api.releases.create(input, uid), winner = await finishBuild(await api.releases.create(input, uid));
    await store.transaction(async tx => { const current = await tx.get<ReleaseJob>(`releases/${old.id}`); tx.put(`releases/${old.id}`, { ...current, codeSha: 'b'.repeat(40) }); });
    await expect(api.releases.retryDispatchJob(old.id)).rejects.toMatchObject({ code: 'BUILD_CODE_CHANGED' });
    await store.transaction(async tx => { const current = await tx.get<ReleaseJob>(`releases/${old.id}`); tx.put(`releases/${old.id}`, { ...current, codeSha }); });
    await api.releases.activate(winner.id, null);
    await expect(api.releases.retryDispatchJob(old.id)).rejects.toMatchObject({ code: 'RELEASE_BASE_CHANGED' });
  });

  it('exposes selected media metadata only to an administrator and does not fetch its original', async () => {
    const asset = await seedAsset('selected_asset'), session = await login();
    expect((await request(`/api/v1/admin/media/${asset.id}`)).status).toBe(401);
    const result = await request(`/api/v1/admin/media/${asset.id}`, session); expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
    expect((await result.json() as { data: MediaAsset }).data).toMatchObject({ id: asset.id, status: 'ready', variants: [{ role: 'content' }] });
    expect((await request('/api/v1/admin/media/missing', session)).status).toBe(404);
    expect((await request('/api/v1/admin/media/invalid%2Fid', session)).status).toBe(422);
  });

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
    expect(await api.media.quota()).toMatchObject({ reservedBytes: 512_000_000, limitBytes: MEDIA_LIMITS.totalBytes });
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
