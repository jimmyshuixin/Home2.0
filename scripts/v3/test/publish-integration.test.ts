import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { CreationDraftSchema } from '@xvyin/contracts';
import { createApi, type Runtime } from '../../../workers/api/src/app';
import type { AuthProvider } from '../../../workers/api/src/auth';
import type { DraftRecord } from '../../../workers/api/src/records';
import type { MediaAsset } from '../../../workers/api/src/media';
import type { ReleaseJob, Snapshot } from '../../../workers/api/src/releases';
import { SqliteStore } from '../../../workers/api/src/store/sqlite';
import { buildManifest, generateStatic, prepareSnapshot, registerBuildManifest, RunnerClient, type Credentials } from '../publish';

// This fixture never contacts test.xvyin.com. Requests go directly to the actual
// Hono application; only the administrator identity is injected. SQLite stores
// actual documents on disk and Miniflare runs actual R2 and HTMLRewriter APIs.
// Nuxt really generates both candidates; no fabricated static HTML is uploaded.
const origin = 'https://test.xvyin.com';
const root = resolve(import.meta.dirname, '../../..');
const title = '本地发布链路测试 · 非线上内容';
const slug = 'local-release-integration';
let directory: string, codeSha: string, mf: Miniflare, store: SqliteStore;
let api: ReturnType<typeof createApi>, credentials: Credentials;
const evidence: Record<string, unknown> = { scope: 'LOCAL_FIXTURE_ONLY', remoteAccountRequests: 0, realNuxtBuilds: [] };
const protocolCounts: Record<string, number> = {};

beforeAll(async () => {
  await mkdir(resolve(root, '.private-build'), { recursive: true, mode: 0o700 });
  directory = await mkdtemp(resolve(root, '.private-build/release-integration-'));
  evidence.directory = directory;
  codeSha = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim();
  evidence.codeSha = codeSha;
  evidence.workingTree = 'Current implementation working copy; this integration deliberately does not claim a committed cloud deployment.';
  mf = new Miniflare({ ...convertV4MiniflareOptions({
    modules: true, compatibilityDate: '2026-09-11', r2Buckets: ['MEDIA'], r2Persist: resolve(directory, 'r2'),
    script: `export default { async fetch(request, env) {
      if (new URL(request.url).pathname === '/r2-upload') {
        const key = request.headers.get('x-fixture-key'), options = JSON.parse(request.headers.get('x-fixture-options'));
        const object = await env.MEDIA.put(key, request.body, options);
        return Response.json(object);
      }
      const {html,selector,prefix} = await request.json();
      return new HTMLRewriter().on(selector, { element(element) { element.prepend(prefix, {html:true}); } }).transform(new Response(html));
    } }`,
  }), telemetry: { enabled: false }, cf: false });
  // The API executes in Node to exercise SqliteStore. This bridge provides its
  // sole Worker-only global by delegating the actual transformation to workerd.
  vi.stubGlobal('HTMLRewriter', class {
    selector = ''; prefix = '';
    on(selector: string, handler: { element(element: { prepend(value: string): void }): void }) {
      this.selector = selector;
      handler.element({ prepend: value => { this.prefix = value; } });
      return this;
    }
    transform(response: Response) {
      const selector = this.selector, prefix = this.prefix;
      const stream = new ReadableStream<Uint8Array>({ async start(controller) {
        try {
          const rewritten = await mf.dispatchFetch('http://local-rewriter.invalid', { method: 'POST', body: JSON.stringify({ html: await response.text(), selector, prefix }) });
          const reader = rewritten.body!.getReader();
          for (;;) { const next = await reader.read(); if (next.done) break; controller.enqueue(next.value); }
          controller.close();
        } catch (error) { controller.error(error); }
      } });
      return new Response(stream, { status: response.status, headers: response.headers });
    }
  });
  store = new SqliteStore(resolve(directory, 'fixture.sqlite'));
  const auth: AuthProvider = {
    signIn: async () => ({ uid: 'local-release-fixture', authTime: Math.floor(Date.now() / 1000) }),
    assertSession: async () => {}, changePassword: async () => {}, requestPasswordReset: async () => {},
    confirmPasswordReset: async () => ({ uid: 'local-release-fixture' }), revokeAllSessions: async () => {},
  };
  // Miniflare exposes the same runtime R2 API with Node-side transport types.
  const actualBucket = await mf.getR2Bucket('MEDIA') as unknown as R2Bucket;
  const bucket = new Proxy(actualBucket, { get(target, property) {
    const member = Reflect.get(target, property);
    if (property === 'put') return async (...args: Parameters<R2Bucket['put']>) => {
      const [key, value, options] = args;
      if (value instanceof ReadableStream) {
        // A Node stream crossing Miniflare's JS proxy loses the native known-
        // length marker. Send the bounded static file as an HTTP request so
        // workerd verifies the actual request body with native R2 put + SHA-256.
        const bytes = await new Response(value).arrayBuffer();
        expect(bytes.byteLength).toBeLessThanOrEqual(25 * 1024 * 1024);
        const response = await mf.dispatchFetch('http://local-r2.invalid/r2-upload', {
          method: 'PUT', body: bytes,
          headers: { 'content-length': String(bytes.byteLength), 'x-fixture-key': key, 'x-fixture-options': JSON.stringify(options) },
        });
        expect(response.status).toBe(200);
        return response.json();
      }
      return target.put(...args);
    };
    return typeof member === 'function' ? member.bind(target) : member;
  } });
  const runtime: Runtime = { store, bucket, auth, now: Date.now, secureCookies: true, allowedOrigins: [origin], privacySalt: 'LOCAL_FIXTURE_SALT_NOT_A_SECRET_'.repeat(2), adminUsername: 'local-release-fixture', codeSha };
  api = createApi(runtime);
  const login = await request('/api/v1/auth/login', { method: 'POST', body: { username: 'local-release-fixture', password: 'synthetic-local-test-password' }, authenticated: false });
  expect(login.status).toBe(200);
  const data = await body<{ csrfToken: string }>(login);
  credentials = { cookie: login.headers.get('set-cookie')!.split(';')[0]!, csrfToken: data.csrfToken };
}, 60000);

afterAll(async () => {
  if (directory) await writeFile(resolve(directory, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  await store?.close();
  await mf?.dispose();
  sharp.cache(false);
  vi.unstubAllGlobals();
});

function request(path: string, options: { method?: string; body?: unknown; authenticated?: boolean; cookie?: string; headers?: Record<string, string> } = {}) {
  return api.app.request(origin + path, {
    method: options.method ?? 'GET',
    headers: { origin, ...(options.authenticated !== false && credentials ? { cookie: options.cookie ?? credentials.cookie, 'x-csrf-token': credentials.csrfToken } : options.cookie ? { cookie: options.cookie } : {}), ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...options.headers },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}
async function body<T>(response: Response): Promise<T> {
  const envelope = await response.json() as { data: T; error?: { code: string }; meta: { schemaVersion: number } };
  expect(response.ok, envelope.error?.code ?? String(response.status)).toBe(true);
  expect(envelope.meta.schemaVersion).toBe(1);
  return envelope.data;
}
async function candidate(record: DraftRecord, action: 'publish' | 'hide', active: string | null): Promise<ReleaseJob> {
  return body<ReleaseJob>(await request('/api/v1/admin/releases', { method: 'POST', body: { changes: [{ collection: 'creations', id: record.id, version: record.version, action }], expectedReleaseId: active } }));
}
function runner(jobId: string, localRunId: string) {
  const localFetch: typeof fetch = (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    if (url.origin !== origin) throw new Error('Fixture refuses an external request');
    const phase = url.pathname.split('/').at(-1)!;
    protocolCounts[phase] = (protocolCounts[phase] ?? 0) + 1;
    return Promise.resolve(api.app.request(url.href, init));
  };
  return new RunnerClient(origin, { jobId, localRunId, mode: 'local' }, credentials, localFetch);
}
async function readyAssetFixtures() {
  // Publish-boundary fixture only: real PNG bytes and explicitly seeded ready
  // metadata. Media decoding/transcoding has its own independent runner suite.
  const bytes = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#345344' } }).png().toBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex'), at = new Date().toISOString();
  const items: { assetId: string; alt: string; sortOrder: number }[] = [];
  for (let index = 0; index < 101; index++) {
    const id = `local-png-${index}`, key = `variants/${id}/content.png`;
    await api.media.bucket.put(key, bytes, { sha256: hash });
    const asset: MediaAsset = { id, kind: 'image', originalName: 'local-test-only.png', originalKey: `originals/${id}/source`, originalBytes: bytes.length, expectedMime: 'image/png', status: 'ready', variants: [{ role: 'content', key, sha256: hash, mime: 'image/png', bytes: bytes.length, url: `/api/v1/media/${id}/content`, width: 8, height: 8 }], createdAt: at, updatedAt: at };
    await store.transaction(async tx => { tx.put(`media/${id}`, asset); });
    items.push({ assetId: id, alt: '明确标记的本地纯色 PNG 测试图', sortOrder: index });
  }
  evidence.preparedFixtureAssets = items.length;
  return items;
}
async function buildCandidate(job: ReleaseJob): Promise<ReleaseJob> {
  const started = Date.now(), client = runner(job.id, randomUUID()), target = resolve(directory, job.id);
  await mkdir(target, { mode: 0o700 });
  const claimed = await prepareSnapshot(client, await client.request<ReleaseJob>('/claim', 'POST', {}));
  expect(claimed.status).toBe('building');
  const snapshot = await client.request<Snapshot>('/snapshot');
  expect(createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')).toBe(claimed.snapshotSha256);
  expect(snapshot.fitness.settings.startDate).toBeNull();
  if (snapshot.creations.length) expect(snapshot.assets).toHaveLength(101);
  const path = resolve(target, 'snapshot.json');
  await writeFile(path, JSON.stringify(snapshot), { mode: 0o600 });
  await generateStatic(root, target, path, origin);
  const output = resolve(root, 'apps/web/.output/public'), manifest = await buildManifest(output, job.id);
  const home = await readFile(resolve(output, 'index.html'), 'utf8');
  expect(home).toContain('aria-label="Hello! I am 虚宁"');
  expect(home).not.toContain('hello！i‘m');
  expect(home).toContain(job.id);
  await writeFile(resolve(target, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  await registerBuildManifest(client, manifest);
  for (const file of manifest.files) await client.request(`/file?path=${encodeURIComponent(file.path)}`, 'PUT', undefined, new Uint8Array(await readFile(resolve(output, decodeURIComponent(file.path).slice(1)))));
  let completed: ReleaseJob | undefined;
  for (let index = 0; index < 1000; index++) {
    completed = await client.request<ReleaseJob>('/finish', 'POST', {});
    if (completed.status === 'ready') break;
    expect(completed.status).toBe('building');
  }
  expect(completed?.status).toBe('ready');
  (evidence.realNuxtBuilds as unknown[]).push({ releaseId: job.id, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0), elapsedMs: Date.now() - started, status: completed!.status });
  return completed!;
}
async function preview(job: ReleaseJob, containsTitle: boolean) {
  const response = await request(`/api/v1/admin/releases/${job.id}/preview`, { method: 'POST', body: {} });
  const value = await body<{ previewUrl: string }>(response);
  expect(value.previewUrl).toBe('/');
  const previewCookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const cookie = `${credentials.cookie}; ${previewCookie}`;
  const htmlResponse = await request('/creations/', { cookie });
  expect(htmlResponse.status).toBe(200);
  expect(htmlResponse.headers.get('cache-control')).toBe('private, no-store');
  expect(htmlResponse.headers.get('x-xvyin-release')).toBe(job.id);
  const html = await htmlResponse.text();
  expect(html).toContain('管理员私密预览');
  expect(html.includes(title)).toBe(containsTitle);
  const assetPath = /(?:src|href)="(\/_nuxt\/[^"?#]+\.js)"/u.exec(html)?.[1];
  expect(assetPath).toBeTruthy();
  const asset = await request(assetPath!, { cookie });
  expect(asset.status).toBe(200);
  expect(asset.headers.get('cache-control')).toBe('private, no-store');
  expect((await request('/creations/', { authenticated: false, cookie: previewCookie })).status).toBe(401);
  expect((await request(assetPath!, { authenticated: false, cookie: previewCookie })).status).toBe(401);
  const closed = await request('/api/v1/admin/preview/close', { method: 'POST', body: {} });
  expect(closed.headers.get('set-cookie')).toContain('Max-Age=0');
}

describe('actual Nuxt / SQLite / workerd R2 publication', () => {
  it('prepares two private releases, previews, activates, hides, rolls back and preserves live content after a failed build', async () => {
    const images = await readyAssetFixtures();
    const record = await body<DraftRecord>(await request('/api/v1/admin/creations', { method: 'POST', body: { draft: CreationDraftSchema.parse({ title, slug, summary: '明确标记的本地集成测试，禁止用于线上种子数据。', blocks: [{ id: 'local-quote', type: 'quote', text: '本地发布链路测试内容' }, { id: 'local-images-one', type: 'gallery', items: images.slice(0, 100) }, { id: 'local-images-two', type: 'gallery', items: images.slice(100) }] }) } }));
    const queued = await candidate(record, 'publish', null);
    expect(queued.snapshotPrepared).toBe(false);
    const first = await buildCandidate(queued);
    expect(protocolCounts.prepare).toBeGreaterThanOrEqual(1);
    expect(protocolCounts.manifest).toBeGreaterThanOrEqual(2);
    expect((await request('/creations/', { authenticated: false })).status).toBe(503);
    await preview(first, true);
    const activated = await body<ReleaseJob>(await request(`/api/v1/admin/releases/${first.id}/activate`, { method: 'POST', body: { expectedReleaseId: null } }));
    expect(activated.status).toBe('live');
    const detail = await request(`/creations/${slug}/`, { authenticated: false });
    expect(detail.status).toBe(200); expect(detail.headers.get('x-xvyin-release')).toBe(first.id); expect(await detail.text()).toContain(title);
    const publicFirst = await request('/api/v1/creations', { authenticated: false });
    expect((await publicFirst.json() as { meta: { releaseId: string } }).meta.releaseId).toBe(first.id);
    const current = await body<DraftRecord>(await request(`/api/v1/admin/creations/${record.id}`));
    expect(current.visibility).toBe('published');
    const second = await buildCandidate(await candidate(current, 'hide', first.id));
    await preview(second, false);
    expect((await request(`/creations/${slug}/`, { authenticated: false })).status).toBe(200);
    expect((await body<ReleaseJob>(await request(`/api/v1/admin/releases/${second.id}/activate`, { method: 'POST', body: { expectedReleaseId: first.id } }))).status).toBe('live');
    expect((await request(`/creations/${slug}/`, { authenticated: false })).status).toBe(404);
    const restored = await body<ReleaseJob>(await request(`/api/v1/admin/releases/${first.id}/activate`, { method: 'POST', body: { expectedReleaseId: second.id } }));
    expect(restored.status).toBe('live');
    const oldDetail = await request(`/creations/${slug}/`, { authenticated: false });
    expect(oldDetail.status).toBe(200); expect(oldDetail.headers.get('x-xvyin-release')).toBe(first.id); expect(await oldDetail.text()).toContain(title);
    const restoredRecord = await body<DraftRecord>(await request(`/api/v1/admin/creations/${record.id}`));
    expect(restoredRecord.visibility).toBe('published');
    const failure = await candidate(restoredRecord, 'hide', first.id), runId = randomUUID(), client = runner(failure.id, runId);
    await client.request('/claim', 'POST', {});
    await expect(runner(failure.id, randomUUID()).request('/fail', 'POST', { code: 'NUXT_BUILD_FAILED' })).rejects.toMatchObject({ code: 'BUILD_STATE_CONFLICT' });
    await expect(client.request('/fail', 'POST', { code: 'private arbitrary error text' })).rejects.toBeDefined();
    const failed = await client.request<ReleaseJob>('/fail', 'POST', { code: 'NUXT_BUILD_FAILED' });
    expect(failed.status).toBe('failed'); expect(failed.error?.code).toBe('NUXT_BUILD_FAILED');
    expect((await client.request<ReleaseJob>('/fail', 'POST', { code: 'NUXT_BUILD_FAILED' })).status).toBe('failed');
    expect((await api.releases.active())?.value.releaseId).toBe(first.id);
    expect((await request(`/creations/${slug}/`, { authenticated: false })).status).toBe(200);
    const persisted = new SqliteStore(resolve(directory, 'fixture.sqlite'));
    expect((await persisted.get<ReleaseJob>(`releases/${failure.id}`))?.status).toBe('failed');
    await persisted.close();
    evidence.result = 'PASS'; evidence.firstRelease = first.id; evidence.secondRelease = second.id; evidence.failedRelease = failure.id; evidence.protocolCounts = protocolCounts;
    evidence.checks = ['101 referenced assets across prepare / manifest pending boundaries', 'real Nuxt HTML and payloads', 'private preview HTML and JS', 'anonymous preview denial', 'atomic active release / API version', 'hide with real 404', 'immutable rollback', 'server-mapped failure + owner isolation', 'failed build leaves previous public version', 'SQLite persistence across handles'];
  }, 300000);
});
