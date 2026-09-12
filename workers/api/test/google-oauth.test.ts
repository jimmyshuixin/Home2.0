import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { createGoogleAccessTokenProvider, GoogleAccessTokenCache, GOOGLE_OAUTH_SCOPES, safeStoreExceptionName, type GoogleServiceAccountConfig } from '../src/store/google-oauth';

let config: GoogleServiceAccountConfig;
let publicKey: CryptoKey;
const instant = Date.UTC(2026, 8, 12, 0, 0, 0);
beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  publicKey = pair.publicKey;
  config = { projectId: 'xvyin-contract-test', clientEmail: 'contract-test@xvyin-contract-test.iam.gserviceaccount.com', privateKey: await exportPKCS8(pair.privateKey) };
});
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('request-scoped service-account OAuth', () => {
  it('reuses only completed tokens across requests and invalidates on expiry, credential or scope changes', async () => {
    const completedTokenCache = new GoogleAccessTokenCache(); let now = instant; let issued = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ access_token: `test-token-${++issued}`, token_type: 'Bearer', expires_in: 3600 }));
    const options = { fetch: fetcher, now: () => now, completedTokenCache };
    expect(await createGoogleAccessTokenProvider(config, options)()).toBe('test-token-1');
    expect(await createGoogleAccessTokenProvider({ ...config }, options)()).toBe('test-token-1');
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 3550_000;
    expect(await createGoogleAccessTokenProvider(config, options)()).toBe('test-token-2');
    expect(await createGoogleAccessTokenProvider(config, { ...options, scopes: [GOOGLE_OAUTH_SCOPES.identityToolkit] })()).toBe('test-token-3');
    expect(completedTokenCache.get({ ...config, privateKey: 'rotated' }, GOOGLE_OAUTH_SCOPES.identityToolkit, now / 1000)).toBeNull();
    expect(completedTokenCache.get({ ...config, projectId: 'another-project' }, GOOGLE_OAUTH_SCOPES.identityToolkit, now / 1000)).toBeNull();
    expect(completedTokenCache.get({ ...config, clientEmail: 'another@auth-test-project.iam.gserviceaccount.com' }, GOOGLE_OAUTH_SCOPES.identityToolkit, now / 1000)).toBeNull();
  });
  it('does not share in-flight I/O promises or cache a failed token issuance', async () => {
    const completedTokenCache = new GoogleAccessTokenCache();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'test' }, { status: 503 }));
    const options = { fetch: fetcher, now: () => instant, completedTokenCache };
    await expect(createGoogleAccessTokenProvider(config, options)()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    fetcher.mockImplementation(async () => Response.json({ access_token: 'test-token', token_type: 'Bearer', expires_in: 3600 }));
    const a = createGoogleAccessTokenProvider(config, options), b = createGoogleAccessTokenProvider(config, options);
    expect(await Promise.all([a(), b()])).toEqual(['test-token', 'test-token']);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('rejects redirects without a second request or accepting a token-shaped redirect body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: 'redirect-token', token_type: 'Bearer', expires_in: 3600 }, { status: 307, headers: { Location: 'https://untrusted.invalid/token' } }));
    await expect(createGoogleAccessTokenProvider(config, { fetch: fetcher })()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });
  it('classifies pre-network key import failures without logging key, message or stack', async () => {
    vi.spyOn(crypto.subtle, 'importKey').mockRejectedValueOnce(new DOMException('private-key-and-provider-detail', 'DataError'));
    const fetcher = vi.fn<typeof fetch>();
    await expect(createGoogleAccessTokenProvider(config, { fetch: fetcher })()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(String(vi.mocked(console.error).mock.calls[0]?.[0]))).toEqual({ level: 'error', code: 'GOOGLE_OAUTH_FAILED', stage: 'key_import', status: null, exceptionName: 'DataError' });
    const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logs).not.toContain('private-key-and-provider-detail');
    expect(logs).not.toContain(config.privateKey); expect(logs).not.toContain(config.clientEmail);
  });

  it('separates signing and fetch failures while rejecting arbitrary exception names', async () => {
    const signer = vi.spyOn(crypto.subtle, 'sign').mockRejectedValueOnce(new TypeError('signing-private-detail'));
    const fetcher = vi.fn<typeof fetch>();
    await expect(createGoogleAccessTokenProvider(config, { fetch: fetcher })()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(String(vi.mocked(console.error).mock.calls[0]?.[0]))).toMatchObject({ stage: 'jwt_sign', status: null, exceptionName: 'TypeError' });
    signer.mockRestore();
    const failure = new Error('oauth-token-private-detail'); failure.name = 'secret-in-untrusted-name';
    fetcher.mockRejectedValueOnce(failure);
    await expect(createGoogleAccessTokenProvider(config, { fetch: fetcher })()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(JSON.parse(String(vi.mocked(console.error).mock.calls[1]?.[0]))).toEqual({ level: 'error', code: 'GOOGLE_OAUTH_FAILED', stage: 'token_fetch', status: null, exceptionName: 'UnknownError' });
    const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
    for (const value of ['signing-private-detail', 'oauth-token-private-detail', failure.name, config.clientEmail, config.privateKey]) expect(logs).not.toContain(value);
    expect(safeStoreExceptionName({ name: 'TypeError', message: 'private' })).toBe('UnknownError');
  });

  it('reports only token HTTP status and fixed validation phase for a provider rejection', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'private-provider-rejection' }, { status: 403 }));
    await expect(createGoogleAccessTokenProvider(config, { fetch: fetcher })()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(JSON.parse(String(vi.mocked(console.error).mock.calls[0]?.[0]))).toEqual({ level: 'error', code: 'GOOGLE_OAUTH_FAILED', stage: 'token_validation', status: 403, exceptionName: 'UnknownError' });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private-provider-rejection');
  });

  it('signs RS256 with a fixed audience and only explicitly selected scopes', async () => {
    let assertion = '';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://oauth2.googleapis.com/token');
      expect(init?.redirect).toBe('manual');
      expect(init?.cache).toBe('no-store');
      const params = new URLSearchParams(String(init?.body));
      expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      assertion = params.get('assertion')!;
      return Response.json({ access_token: 'fake-test-access-token', token_type: 'Bearer', expires_in: 3600 });
    });
    const token = createGoogleAccessTokenProvider(config, { fetch: fetcher, now: () => instant, scopes: [GOOGLE_OAUTH_SCOPES.datastore, GOOGLE_OAUTH_SCOPES.identityToolkit] });
    expect(await token()).toBe('fake-test-access-token');
    const verified = await jwtVerify(assertion, publicKey, { algorithms: ['RS256'], issuer: config.clientEmail, audience: 'https://oauth2.googleapis.com/token', currentDate: new Date(instant) });
    expect(verified.payload.scope).toBe(`${GOOGLE_OAUTH_SCOPES.datastore} ${GOOGLE_OAUTH_SCOPES.identityToolkit}`);
    expect(verified.payload.sub).toBeUndefined();
    expect(verified.payload.exp! - verified.payload.iat!).toBe(3600);
  });

  it('coalesces issuance within one factory and refreshes before expiry without sharing request promises globally', async () => {
    let now = instant; let issued = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ access_token: `test-token-${++issued}`, token_type: 'Bearer', expires_in: 3600 }));
    const token = createGoogleAccessTokenProvider(config, { fetch: fetcher, now: () => now });
    expect(await Promise.all([token(), token()])).toEqual(['test-token-1', 'test-token-1']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 3550 * 1000;
    expect(await token()).toBe('test-token-2');
    const otherRequest = createGoogleAccessTokenProvider(config, { fetch: fetcher, now: () => now });
    expect(await otherRequest()).toBe('test-token-3');
  });

  it('does not reveal upstream error bodies or accept oversized and header-injecting responses', async () => {
    const responses = [
      new Response(JSON.stringify({ error: 'sensitive-provider-error-do-not-return' }), { status: 400 }),
      new Response('x'.repeat(64 * 1024 + 1)),
      Response.json({ access_token: 'bad\r\nInjected:yes', token_type: 'Bearer', expires_in: 3600 }),
    ];
    for (const response of responses) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const token = createGoogleAccessTokenProvider(config, { fetch: fetcher, now: () => instant });
      await expect(token()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', message: '数据服务暂时不可用' });
    }
  });

  it('fails closed before networking when credentials or scopes are absent', () => {
    expect(() => createGoogleAccessTokenProvider({ ...config, privateKey: '' })).toThrowError(expect.objectContaining({ code: 'STORE_NOT_CONFIGURED' }));
    expect(() => createGoogleAccessTokenProvider(config, { scopes: [] })).toThrowError(expect.objectContaining({ code: 'STORE_NOT_CONFIGURED' }));
  });
});
