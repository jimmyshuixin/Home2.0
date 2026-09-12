import { beforeAll, describe, expect, it, vi } from 'vitest';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { createGoogleAccessTokenProvider, GOOGLE_OAUTH_SCOPES, type GoogleServiceAccountConfig } from '../src/store/google-oauth';

let config: GoogleServiceAccountConfig;
let publicKey: CryptoKey;
const instant = Date.UTC(2026, 8, 12, 0, 0, 0);
beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  publicKey = pair.publicKey;
  config = { projectId: 'xvyin-contract-test', clientEmail: 'contract-test@xvyin-contract-test.iam.gserviceaccount.com', privateKey: await exportPKCS8(pair.privateKey) };
});

describe('request-scoped service-account OAuth', () => {
  it('signs RS256 with a fixed audience and only explicitly selected scopes', async () => {
    let assertion = '';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://oauth2.googleapis.com/token');
      expect(init?.redirect).toBe('error');
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
