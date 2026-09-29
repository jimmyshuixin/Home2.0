import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app';
import { MemoryStore } from '../src/store/memory';

const origin = 'https://preview-lifecycle.invalid';
function fixture(secureCookies = true) {
  const now = Date.UTC(2026, 8, 29);
  return createApi({
    store: new MemoryStore(), bucket: { get: async () => null } as unknown as R2Bucket,
    now: () => now, secureCookies, allowedOrigins: [origin], privacySalt: 'local-fixture-only-'.repeat(3), adminUsername: 'admin', codeSha: 'a'.repeat(40),
    auth: { signIn: async () => ({ uid: 'admin', authTime: now / 1000 }), assertSession: async () => {}, changePassword: async () => {}, requestPasswordReset: async () => {}, confirmPasswordReset: async () => ({ uid: 'admin' }), revokeAllSessions: async () => {} },
  });
}

describe('preview cookie lifecycle when authentication ends', () => {
  it.each([true, false])('logout clears both cookies and restores anonymous public reads (secure=%s)', async secure => {
    const api = fixture(secure), previewName = secure ? '__Host-xvyin_preview' : 'xvyin_local_preview';
    const session = await api.sessions.create({ uid: 'admin', authTime: Date.UTC(2026, 8, 29) / 1000 });
    const cookie = `${session.cookie.split(';')[0]}; ${previewName}=private-candidate`;
    const response = await api.app.request(`${origin}/api/v1/auth/logout`, { method: 'POST', headers: { origin, cookie, 'x-csrf-token': session.session.csrfToken }, body: '{}' });
    expect(response.status).toBe(200);
    const cleared = response.headers.getSetCookie();
    expect(cleared).toHaveLength(2);
    for (const name of [api.sessions.cookieName, previewName]) {
      const value = cleared.find(item => item.startsWith(`${name}=`));
      expect(value).toContain('Max-Age=0'); expect(value).toContain('Path=/; HttpOnly; SameSite=Strict');
      expect(value?.includes('; Secure')).toBe(secure);
    }
    // Apply deletion instructions as a browser cookie jar does, then visit public data.
    const cookies = new Map(cookie.split('; ').map(pair => pair.split('=') as [string, string]));
    for (const value of cleared) if (value.includes('Max-Age=0')) cookies.delete(value.slice(0, value.indexOf('=')));
    const publicResponse = await api.app.request(`${origin}/api/v1/settings`, { headers: { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } });
    expect(publicResponse.status).toBe(200);
    expect((await publicResponse.json() as { meta: { releaseId: string } }).meta.releaseId).toBe('unpublished');
    expect((await api.app.request(`${origin}/api/v1/auth/session`, { headers: { cookie } })).status).toBe(401);
  });

  it('password change clears preview and revokes other sessions without removing preview authorization', async () => {
    const api = fixture();
    const first = await api.sessions.create({ uid: 'admin', authTime: Date.UTC(2026, 8, 29) / 1000 });
    const other = await api.sessions.create({ uid: 'admin', authTime: Date.UTC(2026, 8, 29) / 1000 });
    const response = await api.app.request(`${origin}/api/v1/auth/password`, { method: 'POST', headers: { origin, cookie: first.cookie.split(';')[0]!, 'x-csrf-token': first.session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'fixture-old-password', newPassword: 'fixture-new-password' }) });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().find(value => value.startsWith('__Host-xvyin_preview='))).toContain('Max-Age=0');
    expect((await api.app.request(`${origin}/api/v1/auth/session`, { headers: { cookie: other.cookie.split(';')[0]! } })).status).toBe(401);
    expect((await api.app.request(`${origin}/api/v1/settings`, { headers: { cookie: '__Host-xvyin_preview=private-candidate' } })).status).toBe(401);
  });

  it('a confirmed reset clears lingering preview, while rejected logout does not alter cookies', async () => {
    const api = fixture();
    const rejected = await api.app.request(`${origin}/api/v1/auth/logout`, { method: 'POST', headers: { origin, cookie: '__Host-xvyin_preview=private-candidate' }, body: '{}' });
    expect(rejected.status).toBe(401); expect(rejected.headers.getSetCookie()).toEqual([]);
    const reset = await api.app.request(`${origin}/api/v1/auth/reset/confirm`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'fixture-reset-code', newPassword: 'fixture-new-password' }) });
    expect(reset.status).toBe(200); expect(reset.headers.getSetCookie().find(value => value.startsWith('__Host-xvyin_preview='))).toContain('Max-Age=0');
  });
});
