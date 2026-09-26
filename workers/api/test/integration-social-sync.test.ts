import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi, type Runtime } from '../src/app';
import { MemoryStore } from '../src/store/memory';
import { ApiError } from '../src/errors';
import { sanitizeBilibiliProfile } from '../src/bilibili';
import { sanitizeGitHubProfile } from '../src/github-public';

const origin = 'https://test.invalid', now = Date.UTC(2026, 8, 26, 15);
const identity = { runId: 'github-1234', runAttempt: '1', codeSha: 'a'.repeat(40) };
let runtime: Runtime;
beforeEach(() => {
  runtime = {
    store: new MemoryStore(), bucket: {} as R2Bucket, now: () => now, secureCookies: true,
    allowedOrigins: [origin], privacySalt: 'test-only-privacy-salt-'.repeat(3), adminUsername: 'admin', codeSha: 'a'.repeat(40),
    auth: { signIn: async () => ({ uid: 'admin', authTime: now / 1000 }), assertSession: async () => {}, changePassword: async () => {}, requestPasswordReset: async () => {}, confirmPasswordReset: async () => ({ uid: 'admin' }), revokeAllSessions: async () => {} },
    bilibiliFetch: vi.fn(async () => { throw new Error('Unexpected visitor upstream fetch'); }),
  };
});
const submit = (body: unknown) => ({ method: 'POST', headers: { authorization: 'Bearer fixture-identity', 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('anonymous social profiles and dedicated runner routes', () => {
  it('does not accept an admin cookie or publication runner as public-social sync authorization', async () => {
    runtime.verifyRunner = vi.fn(async () => identity);
    const api = createApi(runtime);
    for (const path of ['/claim', '']) {
      const res = await api.app.request(`${origin}/api/v1/internal/social-sync${path}`, submit({}));
      expect(res.status).toBe(401);
    }
    expect(runtime.verifyRunner).not.toHaveBeenCalled(); expect((await runtime.store.list('social_sync')).items).toEqual([]);
  });
  it('authenticates before parsing untrusted payload or writing the store', async () => {
    runtime.verifySocialRunner = vi.fn(async () => { throw new ApiError('SOCIAL_SYNC_UNAUTHORIZED', 403, 'denied'); });
    const res = await createApi(runtime).app.request(`${origin}/api/v1/internal/social-sync`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'malformed upstream body' });
    expect(res.status).toBe(403); expect((await runtime.store.list('social_sync')).items).toEqual([]);
  });
  it('does not grant publication or media authority to the separate social verifier', async () => {
    runtime.verifySocialRunner = vi.fn(async () => identity);
    runtime.verifyRunner = vi.fn(async () => { throw new ApiError('RUNNER_UNAUTHORIZED', 403, 'denied'); });
    const api = createApi(runtime);
    for (const path of ['/api/v1/internal/releases/job-one/claim', '/api/v1/internal/processing/asset-one/claim']) {
      const response = await api.app.request(origin + path, submit({})); expect(response.status).toBe(403);
    }
    expect(runtime.verifySocialRunner).not.toHaveBeenCalled(); expect(runtime.verifyRunner).toHaveBeenCalledTimes(2);
  });
  it('imports only public data then serves both cards without cookies, secrets or direct upstream reads', async () => {
    runtime.verifySocialRunner = async () => identity;
    const api = createApi(runtime);
    const claimResponse = await api.app.request(`${origin}/api/v1/internal/social-sync/claim`, submit({}));
    const claim = (await claimResponse.json() as { data: { claimId: string } }).data;
    const bilibili = sanitizeBilibiliProfile({ code: 0, data: { card: { mid: '520237303', name: '公开作者' }, follower: 42 } }, now);
    const github = sanitizeGitHubProfile({ id: 121843277, login: 'jimmyshuixin', html_url: 'https://github.com/jimmyshuixin', type: 'User', name: '公开作者', email: 'must-not-leak' }, now);
    const res = await api.app.request(`${origin}/api/v1/internal/social-sync`, submit({ claimId: claim.claimId, bilibili: { status: 'ok', profile: bilibili }, github: { status: 'ok', profile: github } }));
    expect(res.status).toBe(200);
    for (const [provider, profile] of [['bilibili', bilibili], ['github', github]] as const) {
      const response = await api.app.request(`${origin}/api/v1/${provider}/profile`, { headers: { cookie: 'SESSDATA=ignored-visitor-value' } });
      expect(response.status).toBe(200); expect((await response.json() as { data: unknown }).data).toEqual(profile);
    }
    expect(runtime.bilibiliFetch).not.toHaveBeenCalled(); expect(JSON.stringify(await runtime.store.list('social_public'))).not.toContain('must-not-leak');
  });
  it('rejects oversized imports before JSON schema traversal', async () => {
    runtime.verifySocialRunner = async () => identity;
    const res = await createApi(runtime).app.request(`${origin}/api/v1/internal/social-sync`, submit({ large: 'x'.repeat(33 * 1024) }));
    expect(res.status).toBe(413);
  });
  it('removes QR/binding/sync endpoints even for a valid administrator', async () => {
    const api = createApi(runtime);
    const login = await api.app.request(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'fixture' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!, csrf = (await login.json() as { data: { csrfToken: string } }).data.csrfToken;
    for (const [method, path] of [['GET', ''], ['POST', '/qr'], ['POST', '/qr/11111111-1111-4111-8111-111111111111/poll'], ['POST', '/sync'], ['POST', '/unlink']]) {
      const res = await api.app.request(`${origin}/api/v1/admin/bilibili${path}`, { method, headers: { cookie, origin, 'x-csrf-token': csrf } });
      expect(res.status).toBe(404);
    }
    expect(runtime.bilibiliFetch).not.toHaveBeenCalled();
  });
});
