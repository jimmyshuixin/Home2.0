/** Isolated browser QA only: real application API, MemoryStore and Miniflare R2.
 * No remote account, bucket, media deletion or production endpoint is available.
 */
import { serve } from '@hono/node-server';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createApi } from '../../../workers/api/src/app';
import { MemoryStore } from '../../../workers/api/src/store/memory';
import { StoreError, type Store } from '../../../workers/api/src/store/types';
import { AuthError, type AuthProvider } from '../../../workers/api/src/auth';
import { EXPIRY_MAINTENANCE_STATE, EXPIRY_MAINTENANCE_LIMITS } from '../../../workers/api/src/maintenance-expiry';

if (process.env.XVYIN_UI_FIXTURE !== '1') throw new Error('Set XVYIN_UI_FIXTURE=1 for isolated UI verification.');
const host = 'http://127.0.0.1:5195', uid = 'phase2-test-identity-never-show';
const mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("isolated phase2 fixture")}}', compatibilityDate: '2026-09-11', r2Buckets: ['FULL', 'EMPTY'] }), telemetry: { enabled: false }, cf: false });
const full = await mf.getR2Bucket('FULL') as unknown as R2Bucket, empty = await mf.getR2Bucket('EMPTY') as unknown as R2Bucket;
const seedObjects: Array<[string, string]> = [];
for (let index = 0; index < 103; index++) seedObjects.push([`originals/qa-private-key-never-show/${String(index).padStart(3, '0')}.jpg`, 'fixture original '.repeat(index % 3 + 1)]);
seedObjects.push(['variants/qa-private-key-never-show/content.webp', 'fixture variant'], ['variants/qa-private-key-never-show/thumb.webp', 'fixture thumb'], ['unclassified/qa-token-never-show', 'fixture other']);
for (let index = 0; index < 8; index++) seedObjects.push([`releases/release-${index}/index.html`, '<p>fixture release</p>'], [`private-snapshots/release-${index}.json`, '{"fixture":true}']);
seedObjects.push(['active-release.json', JSON.stringify({ schemaVersion: 1, releaseId: 'release-7' })]);
for (const [key, body] of seedObjects) await full.put(key, body);
const fullExpected = { count: seedObjects.length, bytes: seedObjects.reduce((total, [, body]) => total + Buffer.byteLength(body), 0) };
let memory: MemoryStore, store: Store, selected = full, app: ReturnType<typeof createApi>['app'];
let offset = 0, expiryFault = false, storageFault = false, writesBlocked = 0, expiredFixtureKeys: string[] = [], retainedFixtureKeys: string[] = [];
const now = () => Date.now() + offset;
const auth: AuthProvider = {
  async signIn({ username, password }) { if (username !== 'ui-fixture' || password !== 'test-only-not-a-real-account') throw new AuthError('AUTH_INVALID_CREDENTIALS'); return { uid, authTime: Math.floor(now() / 1000) }; },
  async assertSession(identity) { if (identity.uid !== uid) throw new AuthError('AUTH_SESSION_REVOKED'); },
  async changePassword() { throw new AuthError('AUTH_NOT_CONFIGURED'); }, async requestPasswordReset() { throw new AuthError('AUTH_NOT_CONFIGURED'); }, async confirmPasswordReset() { throw new AuthError('AUTH_NOT_CONFIGURED'); }, async revokeAllSessions() {},
};
function reset(emptyData = false) {
  offset = 0; expiryFault = false; storageFault = false; writesBlocked = 0; expiredFixtureKeys = []; retainedFixtureKeys = [];
  const seed: Record<string, unknown> = { 'comments/preserved-comment': { body: 'Existing comment remains intact' } };
  if (!emptyData) {
    for (const [collection, count] of [['sessions', 8], ['rates', 5], ['idempotency', 4]] as const) {
      for (let index = 0; index < count; index++) { const key = `${collection}/old-${index}`; expiredFixtureKeys.push(key); seed[key] = { expiresAt: now() - 100000, secret: 'qa-private-payload-never-show' }; }
      const future = `${collection}/future`, invalid = `${collection}/invalid`;
      seed[future] = { expiresAt: now() + 7 * 86400000 }; seed[invalid] = { expiresAt: 'unknown', secret: 'qa-private-payload-never-show' }; retainedFixtureKeys.push(future, invalid);
    }
    for (let index = 0; index < 8; index++) seed[`releases/release-${index}`] = { id: `release-${index}`, status: index === 7 ? 'live' : 'superseded', createdAt: new Date(now() - (8 - index) * 86400000).toISOString(), previousReleaseId: index ? `release-${index - 1}` : null, selectedRevisionIds: {} };
  }
  memory = new MemoryStore(seed);
  store = new Proxy(memory, { get(target, property) {
    if (property === 'list') return async (collection: string, options: unknown) => { if (expiryFault && ['sessions', 'rates', 'idempotency'].includes(collection)) { expiryFault = false; throw new StoreError('STORE_UNAVAILABLE'); } return target.list(collection, options as never); };
    if (property === 'queryExpired') return async (...args: Parameters<MemoryStore['queryExpired']>) => { if (expiryFault) { expiryFault = false; throw new StoreError('STORE_UNAVAILABLE'); } return target.queryExpired(...args); };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  selected = emptyData ? empty : full;
  const denyWrite = () => { writesBlocked++; throw new Error('Local fixture prohibits all R2 mutations after seeding'); };
  const bucket = { list: async (options: R2ListOptions) => { if (storageFault) { storageFault = false; throw new Error('qa-private-key-never-show: simulated R2 list failure'); } return selected.list(options); }, get: selected.get.bind(selected), head: selected.head.bind(selected), put: denyWrite, delete: denyWrite, createMultipartUpload: denyWrite, resumeMultipartUpload: denyWrite } as unknown as R2Bucket;
  app = createApi({ store, bucket, auth, now, secureCookies: false, allowedOrigins: [host], privacySalt: 'local-test-only-nonsecret-salt-xxxxxxxxxxxxxxxx', adminUsername: 'ui-fixture', codeSha: 'b'.repeat(40) }).app;
}
reset();
const root = resolve(import.meta.dirname, '../dist');
const server = serve({ hostname: '127.0.0.1', port: 5195, fetch: async request => {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/__fixture/')) {
    if (request.headers.get('x-local-ui-fixture') !== 'phase2-only') return new Response('Local fixture control required', { status: 403 });
    if (url.pathname === '/__fixture/shutdown' && request.method === 'POST') { setTimeout(() => { void close(); }, 100); return Response.json({ stopping: true }); }
    if (url.pathname === '/__fixture/reset' && request.method === 'POST') { const body = await request.json() as { empty?: boolean }; reset(body.empty === true); return Response.json({ reset: true }); }
    if (url.pathname === '/__fixture/fault' && request.method === 'POST') { const body = await request.json() as { target: string }; if (body.target === 'expiry') expiryFault = true; else if (body.target === 'storage') storageFault = true; else return new Response('Unknown target', { status: 400 }); return Response.json({ armed: true }); }
    if (url.pathname === '/__fixture/clock' && request.method === 'POST') { const body = await request.json() as { advanceMs: number }; if (!Number.isSafeInteger(body.advanceMs) || body.advanceMs < 0 || body.advanceMs > 172800000) return new Response('Invalid time', { status: 400 }); offset += body.advanceMs; return Response.json({ advanced: true }); }
    if (url.pathname === '/__fixture/expiry-budget' && request.method === 'POST') {
      await memory.transaction(async tx => { const state = await tx.get<Record<string, any>>(EXPIRY_MAINTENANCE_STATE); if (!state) throw new Error('Run at least one maintenance step first'); const steps = EXPIRY_MAINTENANCE_LIMITS.dailySteps; tx.put(EXPIRY_MAINTENANCE_STATE, { ...state, budget: { day: new Date(now()).toISOString().slice(0, 10), steps, reads: steps * EXPIRY_MAINTENANCE_LIMITS.readsPerStep, writes: steps * EXPIRY_MAINTENANCE_LIMITS.writesPerStep, deletes: steps * EXPIRY_MAINTENANCE_LIMITS.deletesPerStep } }); });
      return Response.json({ exhausted: true });
    }
    if (url.pathname === '/__fixture/diagnostics' && request.method === 'GET') {
      const existingExpired = await memory.getMany(expiredFixtureKeys), retained = await memory.getMany(retainedFixtureKeys);
      return Response.json({ expectedStorage: selected === full ? fullExpected : { count: 0, bytes: 0 }, expiredFixtureTotal: expiredFixtureKeys.length, remainingExpiredFixture: existingExpired.filter(Boolean).length, retainedFixtureTotal: retainedFixtureKeys.length, retainedFixturePresent: retained.filter(Boolean).length, commentPreserved: (await memory.get<{ body: string }>('comments/preserved-comment'))?.body === 'Existing comment remains intact', r2MutationsAttempted: writesBlocked });
    }
    return new Response('Unknown fixture control', { status: 404 });
  }
  if (url.pathname.startsWith('/api/')) { if (request.method === 'POST' && url.pathname.startsWith('/api/v1/admin/maintenance/')) await new Promise(resolve => setTimeout(resolve, 450)); return app.fetch(request); }
  const path = url.pathname.startsWith('/admin/assets/') || url.pathname.startsWith('/admin/fonts/') ? resolve(root, url.pathname.slice('/admin/'.length)) : resolve(root, 'index.html');
  if (!path.startsWith(root + '/') && !path.startsWith(root + '\\')) return new Response('Not found', { status: 404 });
  try { let body = await readFile(path); if (extname(path) === '.html') body = Buffer.from(body.toString('utf8').replace('<title>', '<title>本地维护验证 · ').replace('</body>', '<div style="position:fixed;bottom:0;inset-inline:0;z-index:10000;background:#7b392e;color:white;text-align:center;padding:3px;font:11px sans-serif">本地维护测试 · 真实 API / 测试数据库 / Miniflare R2 · 无远端写入</div></body>')); return new Response(body, { headers: { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' } }); } catch { return new Response('Not found', { status: 404 }); }
} }, () => console.log(`Isolated maintenance fixture: ${host}/admin/`));
async function close() { server.close(); await mf.dispose(); process.exit(0); }
process.once('SIGINT', close); process.once('SIGTERM', close);
