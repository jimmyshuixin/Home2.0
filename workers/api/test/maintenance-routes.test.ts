import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../src/app';
import { MemoryStore } from '../src/store/memory';

const origin = 'https://maintenance-routes.invalid', now = Date.UTC(2026, 8, 29);
function fixture() {
  const store = new MemoryStore({ 'rates/private-row': { count: 1, expiresAt: now - 1 }, 'idempotency/private-receipt': { hash: 'private-hash', receipt: { receiptId: 'private-comment' }, expiresAt: now - 1 } });
  const list = vi.fn(async () => ({ objects: [{ key: 'originals/private-asset/private-photo.jpg', size: 123, uploaded: new Date(now) }], truncated: false, delimitedPrefixes: [] }));
  const remove = vi.fn(async () => {});
  const bucket = { get: vi.fn(async () => null), list, delete: remove } as unknown as R2Bucket;
  const api = createApi({ store, bucket, now: () => now, secureCookies: true, allowedOrigins: [origin], privacySalt: 'local-routes-only-salt-'.repeat(3), adminUsername: 'admin', codeSha: 'a'.repeat(40),
    auth: { signIn: async () => ({ uid: 'admin', authTime: now / 1000 }), assertSession: async () => {}, changePassword: async () => {}, requestPasswordReset: async () => {}, confirmPasswordReset: async () => ({ uid: 'admin' }), revokeAllSessions: async () => {} } });
  return { store, api, list, remove };
}
const mutations = [
  ['/expiry/advance', {}], ['/storage/start', { expectedVersion: 0 }],
  ['/storage/advance', { jobId: '00000000-0000-4000-8000-000000000001', expectedVersion: 0 }],
  ['/storage/pause', { jobId: '00000000-0000-4000-8000-000000000001', expectedVersion: 0 }],
] as const;
describe('administrator maintenance route boundaries', () => {
  it('requires a valid administrator session for all statuses and mutations', async () => {
    const f = fixture();
    for (const suffix of ['/expiry', '/storage']) expect((await f.api.app.request(`${origin}/api/v1/admin/maintenance${suffix}`)).status).toBe(401);
    for (const [suffix, body] of mutations) {
      const response = await f.api.app.request(`${origin}/api/v1/admin/maintenance${suffix}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(401);
    }
    expect(f.list).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    expect(await f.store.get('rates/private-row')).not.toBeNull();
  });
  it('requires CSRF and same-site Origin before every mutation and rejects excess fields', async () => {
    const f = fixture(), session = await f.api.sessions.create({ uid: 'admin', authTime: now / 1000 });
    const cookie = session.cookie.split(';')[0]!;
    for (const [suffix, body] of mutations) {
      const request = (headers: Record<string, string>, payload: unknown = body) => f.api.app.request(`${origin}/api/v1/admin/maintenance${suffix}`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
      expect((await request({})).status).toBe(403);
      expect((await request({ 'x-csrf-token': session.session.csrfToken, origin: 'https://attacker.invalid' })).status).toBe(403);
      expect((await request({ 'x-csrf-token': session.session.csrfToken }, { ...body, deleteAll: true })).status).toBe(422);
    }
    expect(f.list).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });
  it('exposes only maintenance summaries, uses versioned inventory steps and never deletes R2 objects', async () => {
    const f = fixture(), session = await f.api.sessions.create({ uid: 'admin', authTime: now / 1000 });
    const headers = { origin, cookie: session.cookie.split(';')[0]!, 'content-type': 'application/json', 'x-csrf-token': session.session.csrfToken };
    const call = async (suffix: string, body?: unknown) => {
      const response = await f.api.app.request(`${origin}/api/v1/admin/maintenance${suffix}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      for (const privateValue of ['private-row', 'private-receipt', 'private-hash', 'private-photo.jpg', session.session.csrfToken, session.session.id]) expect(text).not.toContain(privateValue);
      return JSON.parse(text).data;
    };
    await call('/expiry'); await call('/expiry/advance', {});
    const status = await call('/storage');
    let scan = await call('/storage/start', { expectedVersion: status.version });
    const startedVersion = scan.version;
    scan = await call('/storage/advance', { jobId: scan.job.id, expectedVersion: scan.version });
    expect(scan.job.total).toEqual({ bytes: 123, count: 1 });
    const replay = await f.api.app.request(`${origin}/api/v1/admin/maintenance/storage/advance`, { method: 'POST', headers, body: JSON.stringify({ jobId: scan.job.id, expectedVersion: startedVersion }) });
    expect([200, 409]).toContain(replay.status);
    scan = await call('/storage'); expect(scan.job.total).toEqual({ bytes: 123, count: 1 });
    expect(f.list).toHaveBeenCalledTimes(1); expect(f.remove).not.toHaveBeenCalled();
  });
});
