import { beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { AuthError, createAuthProvider, FirebasePasswordProvider, type FirebasePasswordConfig } from '../src/auth';

const NOW = Date.parse('2026-09-12T04:00:00Z');
const SECONDS = NOW / 1000;
const config: FirebasePasswordConfig = {
  projectId: 'auth-test-project',
  apiKey: 'test_api_key_not_a_real_credential_12345',
  adminUid: 'test-admin-uid',
  adminUsername: 'test-owner',
  adminEmail: 'owner@example.test',
  passwordResetUrl: 'https://site.example.test/admin/reset-password',
};
const password = 'fictional current password for tests';
const newPassword = 'fictional replacement passphrase';
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let wrongKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: JWK;

beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  wrongKeys = await generateKeyPair('RS256');
  publicKey = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
});

async function token(overrides: Record<string, unknown> = {}, signingKey = keys.privateKey) {
  return new SignJWT({
    iss: `https://securetoken.google.com/${config.projectId}`,
    aud: config.projectId,
    sub: config.adminUid,
    iat: SECONDS,
    exp: SECONDS + 3600,
    auth_time: SECONDS,
    ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(signingKey);
}

type MockOptions = {
  idToken?: string;
  loginUid?: string;
  user?: Record<string, unknown>;
  loginFailure?: { status: number; message: string };
  lookupFailure?: boolean;
  resetEmail?: string;
  resetFailure?: boolean;
  throwFetch?: boolean;
};

async function harness(options: MockOptions = {}) {
  const idToken = options.idToken ?? await token();
  const calls: { url: string; method?: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const upstreamSecret = 'upstream-sensitive-value-must-never-escape';
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    if (options.throwFetch) throw new Error(upstreamSecret);
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, method: init?.method, headers: new Headers(init?.headers), body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/service_accounts/v1/jwk/')) return json({ keys: [publicKey] });
    if (url.includes('accounts:signInWithPassword')) {
      if (options.loginFailure) return json({ error: { message: options.loginFailure.message }, debug: upstreamSecret }, options.loginFailure.status);
      return json({ idToken, localId: options.loginUid ?? config.adminUid, refreshToken: upstreamSecret, email: config.adminEmail });
    }
    if (url.includes('accounts:lookup')) {
      if (options.lookupFailure) return json({ error: { message: upstreamSecret } }, 403);
      return json({ users: [{ localId: config.adminUid, email: config.adminEmail, validSince: String(SECONDS - 3600), disabled: false, ...options.user }] });
    }
    if (url.includes('accounts:sendOobCode')) return json({ email: config.adminEmail });
    if (url.includes('accounts:resetPassword')) {
      if (options.resetFailure) return json({ error: { message: 'EXPIRED_OOB_CODE' } }, 400);
      return json({ email: options.resetEmail ?? config.adminEmail, requestType: 'PASSWORD_RESET' });
    }
    if (url.includes('accounts:update')) return json({ localId: config.adminUid, idToken, refreshToken: upstreamSecret });
    throw new Error('Unexpected test endpoint');
  });
  const provider = new FirebasePasswordProvider(config, {
    fetch: fetchMock,
    now: () => NOW,
    getGoogleAccessToken: async () => 'test-server-oauth-token',
  });
  return { provider, fetchMock, calls, idToken, upstreamSecret };
}

describe('FirebasePasswordProvider login', () => {
  it('returns only an identity after signature and server-side account validation', async () => {
    const h = await harness();
    const identity = await h.provider.signIn({ username: config.adminUsername, password });
    expect(identity).toEqual({ uid: config.adminUid, authTime: SECONDS });
    expect(JSON.stringify(identity)).not.toContain(h.idToken);
    expect(JSON.stringify(identity)).not.toContain(h.upstreamSecret);
    const login = h.calls.find(call => call.url.includes('signInWithPassword'))!;
    expect(login.body).toEqual({ email: config.adminEmail, password, returnSecureToken: true });
    const lookup = h.calls.find(call => call.url.includes('accounts:lookup'))!;
    expect(lookup.headers.get('authorization')).toBe('Bearer test-server-oauth-token');
    expect(lookup.body).toEqual({ localId: [config.adminUid] });
  });

  it.each([
    ['wrong UID', { sub: 'other-user' }],
    ['wrong issuer', { iss: 'https://attacker.example.test' }],
    ['wrong audience', { aud: 'another-project' }],
    ['ambiguous audience list', { aud: [config.projectId, 'another-project'] }],
    ['expired token', { exp: SECONDS }],
    ['future authentication time', { auth_time: SECONDS + 1 }],
    ['stale authentication proof', { auth_time: SECONDS - 301 }],
    ['future issue time', { iat: SECONDS + 1 }],
    ['fractional authentication time', { auth_time: SECONDS - 0.5 }],
    ['missing authentication time', { auth_time: undefined }],
    ['missing expiry', { exp: undefined }],
  ])('rejects %s even with a valid Firebase signing key', async (_label, overrides) => {
    const h = await harness({ idToken: await token(overrides) });
    await expect(h.provider.signIn({ username: config.adminUsername, password })).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS', status: 401 });
    expect(h.calls.some(call => call.url.includes('accounts:lookup'))).toBe(false);
  });

  it('rejects a forged RSA signature', async () => {
    const h = await harness({ idToken: await token({}, wrongKeys.privateKey) });
    await expect(h.provider.signIn({ username: config.adminUsername, password })).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
  });

  it('rejects HS256 algorithm confusion', async () => {
    const forged = await new SignJWT({ sub: config.adminUid }).setProtectedHeader({ alg: 'HS256', kid: 'test-key' }).sign(new Uint8Array(32).fill(7));
    const h = await harness({ idToken: forged });
    await expect(h.provider.signIn({ username: config.adminUsername, password })).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
  });

  it('rejects an unconfigured username without submitting passwords to a different identity', async () => {
    const h = await harness();
    await expect(h.provider.signIn({ username: 'other-user', password })).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a different localId from the password endpoint', async () => {
    const h = await harness({ loginUid: 'other-user' });
    await expect(h.provider.signIn({ username: config.adminUsername, password })).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    expect(h.calls).toHaveLength(1);
  });

  it.each([
    [400, 'INVALID_LOGIN_CREDENTIALS', 'AUTH_INVALID_CREDENTIALS'],
    [400, 'USER_DISABLED', 'AUTH_INVALID_CREDENTIALS'],
    [400, 'OPERATION_NOT_ALLOWED', 'AUTH_UNAVAILABLE'],
    [429, 'TOO_MANY_ATTEMPTS_TRY_LATER', 'AUTH_RATE_LIMITED'],
    [503, 'upstream-sensitive-value-must-never-escape', 'AUTH_UNAVAILABLE'],
  ])('sanitizes provider failure %s %s', async (status, message, code) => {
    const h = await harness({ loginFailure: { status, message } });
    try {
      await h.provider.signIn({ username: config.adminUsername, password });
      expect.unreachable('failure must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect(error).toMatchObject({ code });
      expect(JSON.stringify(error)).not.toContain(password);
      expect(JSON.stringify(error)).not.toContain(h.idToken);
      expect(JSON.stringify(error)).not.toContain(h.upstreamSecret);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('does not expose a fetch error or credentials in its cause', async () => {
    const h = await harness({ throwFetch: true });
    try { await h.provider.signIn({ username: config.adminUsername, password }); throw new Error('Expected rejection'); }
    catch (error) { expect(error).toMatchObject({ code: 'AUTH_UNAVAILABLE' }); expect((error as Error).cause).toBeUndefined(); expect(JSON.stringify(error)).not.toContain(password); }
  });
});

describe('authoritative session validation and revocation', () => {
  it.each([
    ['disabled account', { disabled: true }, 'AUTH_SESSION_REVOKED'],
    ['changed email', { email: 'attacker@example.test' }, 'AUTH_SESSION_REVOKED'],
    ['changed UID', { localId: 'other-user' }, 'AUTH_SESSION_REVOKED'],
    ['revoked authentication time', { validSince: String(SECONDS + 1) }, 'AUTH_SESSION_REVOKED'],
    ['missing revocation metadata', { validSince: undefined }, 'AUTH_UNAVAILABLE'],
    ['malformed revocation metadata', { validSince: 'NaN' }, 'AUTH_UNAVAILABLE'],
  ])('rejects %s', async (_label, user, code) => {
    const h = await harness({ user });
    await expect(h.provider.assertSession({ uid: config.adminUid, authTime: SECONDS })).rejects.toMatchObject({ code });
  });

  it('fails closed when service-account lookup is unavailable', async () => {
    const h = await harness({ lookupFailure: true });
    await expect(h.provider.assertSession({ uid: config.adminUid, authTime: SECONDS })).rejects.toMatchObject({ code: 'AUTH_UNAVAILABLE' });
  });

  it('does not impose the recent-login window on an existing valid session', async () => {
    const h = await harness();
    await expect(h.provider.assertSession({ uid: config.adminUid, authTime: SECONDS - 1800 })).resolves.toBeUndefined();
  });

  it('updates Firebase validSince only for the configured administrator', async () => {
    const h = await harness();
    await h.provider.revokeAllSessions(config.adminUid);
    expect(h.calls[0]?.body).toEqual({ localId: config.adminUid, validSince: String(SECONDS) });
    await expect(h.provider.revokeAllSessions('other-user')).rejects.toMatchObject({ code: 'AUTH_SESSION_REVOKED' });
    expect(h.calls).toHaveLength(1);
  });
});

describe('password changes and fixed-recipient recovery', () => {
  it('reauthenticates the current password before changing it', async () => {
    const h = await harness();
    await h.provider.changePassword({ uid: config.adminUid, currentPassword: password, newPassword });
    expect(h.calls[0]?.url).toContain('signInWithPassword');
    const update = h.calls.find(call => call.url.includes('accounts:update'))!;
    expect(update.body).toEqual({ idToken: h.idToken, password: newPassword, returnSecureToken: true });
  });

  it('does not change the password if current-password validation fails', async () => {
    const h = await harness({ loginFailure: { status: 400, message: 'INVALID_LOGIN_CREDENTIALS' } });
    await expect(h.provider.changePassword({ uid: config.adminUid, currentPassword: password, newPassword })).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    expect(h.calls.some(call => call.url.includes('accounts:update'))).toBe(false);
  });

  it('requires the local password-length policy before making remote calls', async () => {
    const h = await harness();
    await expect(h.provider.changePassword({ uid: config.adminUid, currentPassword: password, newPassword: 'short' })).rejects.toMatchObject({ code: 'AUTH_PASSWORD_POLICY' });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('sends recovery only to the configured email; unknown username is a silent no-op', async () => {
    const h = await harness();
    await h.provider.requestPasswordReset({ username: 'other-user' });
    expect(h.fetchMock).not.toHaveBeenCalled();
    await h.provider.requestPasswordReset({ username: config.adminUsername });
    const recovery = h.calls.find(call => call.url.includes('sendOobCode'))!;
    expect(recovery.body).toEqual({ requestType: 'PASSWORD_RESET', email: config.adminEmail, continueUrl: config.passwordResetUrl });
  });

  it('verifies a reset code belongs to the fixed administrator before consuming it', async () => {
    const h = await harness();
    await expect(h.provider.confirmPasswordReset({ code: 'test-reset-code', newPassword })).resolves.toEqual({ uid: config.adminUid });
    const resetCalls = h.calls.filter(call => call.url.includes('resetPassword'));
    expect(resetCalls.map(call => call.body)).toEqual([
      { oobCode: 'test-reset-code' },
      { oobCode: 'test-reset-code', newPassword },
    ]);
  });

  it('does not reset another account even with its valid action code', async () => {
    const h = await harness({ resetEmail: 'other@example.test' });
    await expect(h.provider.confirmPasswordReset({ code: 'test-reset-code', newPassword })).rejects.toMatchObject({ code: 'AUTH_INVALID_RESET_CODE' });
    expect(h.calls.some(call => 'newPassword' in call.body)).toBe(false);
  });

  it('rejects expired recovery codes without leaking the code', async () => {
    const h = await harness({ resetFailure: true });
    await expect(h.provider.confirmPasswordReset({ code: 'test-reset-code', newPassword })).rejects.toMatchObject({ code: 'AUTH_INVALID_RESET_CODE' });
  });
});

describe('strict runtime configuration and upstream response bounds', () => {
  it.each([
    undefined,
    {},
    { ...config, apiKey: '' },
    { ...config, adminUid: '' },
    { ...config, adminEmail: 'invalid-address' },
    { ...config, passwordResetUrl: 'http://example.test/reset' },
    { ...config, passwordResetUrl: 'https://user:password@example.test/reset' },
  ])('fails closed for incomplete or invalid runtime configuration', async value => {
    const fetchMock = vi.fn<typeof fetch>();
    const provider = createAuthProvider(value, { fetch: fetchMock, getGoogleAccessToken: async () => 'unused' });
    await expect(provider.signIn({ username: config.adminUsername, password })).rejects.toMatchObject({ code: 'AUTH_NOT_CONFIGURED', status: 503 });
    await expect(provider.assertSession({ uid: config.adminUid, authTime: SECONDS })).rejects.toMatchObject({ code: 'AUTH_NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized upstream responses before parsing them', async () => {
    const provider = createAuthProvider(config, {
      now: () => NOW,
      getGoogleAccessToken: async () => 'unused',
      fetch: vi.fn<typeof fetch>(async () => new Response('x'.repeat(129 * 1024))),
    });
    await expect(provider.signIn({ username: config.adminUsername, password })).rejects.toMatchObject({ code: 'AUTH_UNAVAILABLE' });
  });

  it('sanitizes invalid JSON and does not expose provider response text', async () => {
    const provider = createAuthProvider(config, {
      getGoogleAccessToken: async () => 'unused',
      fetch: vi.fn<typeof fetch>(async () => new Response('private invalid upstream response')),
    });
    await expect(provider.signIn({ username: config.adminUsername, password })).rejects.toMatchObject({ code: 'AUTH_UNAVAILABLE' });
  });
});
