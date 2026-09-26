import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi, type Runtime } from '../src/app';
import { MemoryStore } from '../src/store/memory';

const origin = 'https://test.invalid';
const now = Date.UTC(2026, 8, 26, 13);
let runtime: Runtime;
beforeEach(() => {
  runtime = {
    store: new MemoryStore(), bucket: {} as R2Bucket, now: () => now, secureCookies: true,
    allowedOrigins: [origin], privacySalt: 'test-only-privacy-salt-'.repeat(3), adminUsername: 'admin', codeSha: 'a'.repeat(40),
    auth: { signIn: async () => ({ uid: 'admin', authTime: now / 1000 }), assertSession: async () => {}, changePassword: async () => {}, requestPasswordReset: async () => {}, confirmPasswordReset: async () => ({ uid: 'admin' }), revokeAllSessions: async () => {} },
    bilibiliFetch: vi.fn(async () => { throw new Error('upstream must not be called before authorization'); }),
  };
});
async function login(api: ReturnType<typeof createApi>) {
  const response = await api.app.request(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-only-password' }) });
  const body = await response.json() as { data: { csrfToken: string } };
  expect(response.status).toBe(200);
  return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: body.data.csrfToken };
}
describe('Bilibili administrator route boundaries', () => {
  it.each([
    ['GET', '/api/v1/admin/bilibili'],
    ['POST', '/api/v1/admin/bilibili/qr'],
    ['POST', '/api/v1/admin/bilibili/qr/11111111-1111-4111-8111-111111111111/poll'],
    ['POST', '/api/v1/admin/bilibili/sync'],
    ['POST', '/api/v1/admin/bilibili/unlink'],
  ])('requires an administrator session for %s %s', async (method, path) => {
    const api = createApi(runtime);
    const response = await api.app.request(origin + path, { method, headers: { origin } });
    expect(response.status).toBe(401);
    expect(runtime.bilibiliFetch).not.toHaveBeenCalled();
  });
  it('rejects mutations without CSRF and rejects foreign origins before invoking Bilibili', async () => {
    const api = createApi(runtime), session = await login(api);
    for (const path of ['/qr', '/qr/11111111-1111-4111-8111-111111111111/poll', '/sync', '/unlink']) {
      const response = await api.app.request(`${origin}/api/v1/admin/bilibili${path}`, { method: 'POST', headers: { origin, cookie: session.cookie } });
      expect(response.status).toBe(403);
    }
    const foreign = await api.app.request(`${origin}/api/v1/admin/bilibili/qr`, { method: 'POST', headers: { origin: 'https://foreign.invalid', cookie: session.cookie, 'x-csrf-token': session.csrf } });
    expect(foreign.status).toBe(403);
    expect(runtime.bilibiliFetch).not.toHaveBeenCalled();
  });
  it('reports unconfigured status and fails closed when starting a QR without encryption', async () => {
    const api = createApi(runtime), session = await login(api);
    const status = await api.app.request(`${origin}/api/v1/admin/bilibili`, { headers: { cookie: session.cookie } });
    expect(status.headers.get('cache-control')).toBe('no-store');
    expect(await status.json()).toMatchObject({ data: { uid: '520237303', configured: false, state: 'unbound' } });
    const start = await api.app.request(`${origin}/api/v1/admin/bilibili/qr`, { method: 'POST', headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrf } });
    expect(start.status).toBe(503);
    expect(runtime.bilibiliFetch).not.toHaveBeenCalled();
  });
});
