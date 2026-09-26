import { describe, expect, it, vi } from 'vitest';
import { BilibiliProfileSchema, GitHubProfileSchema, SocialSyncInputSchema } from '@xvyin/contracts';
import { bilibiliProfile, githubProfile, githubRepositories, collectSources, oidcToken, requestJson, syncPublicData } from '../public-social-sync';

const now = Date.parse('2026-09-26T15:00:00.000Z');
const bili = { code: 0, data: { card: { mid: '520237303', name: '测试 UP', sign: '公开简介', face: 'https://i1.hdslb.com/bfs/face/avatar.webp', password: 'must-not-copy' }, follower: 2545, archive_count: 451, like_num: 46378 } };
const gh = { id: 121843277, login: 'jimmyshuixin', type: 'User', html_url: 'https://github.com/jimmyshuixin', name: 'xvyin', bio: 'public', avatar_url: 'https://avatars.githubusercontent.com/u/121843277?v=4', public_repos: 8, followers: 2, following: 1, private_gists: 7 };
const repo = (name: string, more: Record<string, unknown> = {}) => ({ name, owner: { id: 121843277, login: 'jimmyshuixin' }, private: false, fork: false, visibility: 'public', html_url: `https://github.com/jimmyshuixin/${name}`, stargazers_count: 3, forks_count: 1, pushed_at: '2026-09-25T10:00:00Z', ...more });
const json = (body: unknown, headers?: HeadersInit) => Response.json(body, { headers });
const environment = { GITHUB_REPOSITORY: 'jimmyshuixin/Home2.0', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://run-actions-1.actions.githubusercontent.com/token?existing=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-only-secret' };

describe('dependency-free public social runner', () => {
  it('projects only approved Bilibili fields and rejects identity substitution', () => {
    const result = bilibiliProfile(bili, now);
    expect(BilibiliProfileSchema.parse(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain('must-not-copy');
    expect(result.followers).toBe(2545);
    expect(() => bilibiliProfile({ ...bili, data: { ...bili.data, card: { ...bili.data.card, mid: '123' } } }, now)).toThrow('invalid-response');
    expect(bilibiliProfile({ ...bili, data: { ...bili.data, like_num: -1, card: { ...bili.data.card, face: 'https://evil.test/avatar.webp', name: '<script>x</script>\u0000 UP' } } }, now)).toMatchObject({ name: 'x  UP', likes: null, avatarUrl: null });
  });
  it('does not copy private account fields and selects only verified own public non-forks', () => {
    const profile = githubProfile(gh, now);
    expect(GitHubProfileSchema.parse(profile)).toEqual(profile);
    expect(JSON.stringify(profile)).not.toContain('private_gists');
    expect(() => githubProfile({ ...gh, id: 1 }, now)).toThrow('invalid-response');
    const selected = githubRepositories([repo('good'), repo('private', { private: true }), repo('fork', { fork: true }), repo('foreign', { owner: { id: 1, login: 'other' } }), repo('internal', { visibility: 'private' })], now);
    expect(selected.map(value => value.name)).toEqual(['good']);
    expect(() => githubRepositories([repo('redirect', { html_url: 'https://evil.test/' })], now)).toThrow('invalid-response');
    expect(() => githubRepositories([repo('bad-count', { stargazers_count: -1 })], now)).toThrow('invalid-response');
  });
  it('rejects redirects and caps undeclared streamed responses', async () => {
    const redirect = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      expect(options?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://evil.test/' } });
    });
    await expect(requestJson('https://xvyin-v3-test.pages.dev/api/v1/internal/social-sync', { headers: { authorization: 'Bearer test' } }, 50, redirect)).rejects.toThrow('unavailable');
    expect(redirect).toHaveBeenCalledTimes(1);
    await expect(requestJson('https://api.github.com/users/jimmyshuixin', {}, 4, async () => new Response('12345'))).rejects.toThrow('invalid-response');
  });
  it('isolates platform failures and never forwards credentials to provider APIs', async () => {
    const result = await collectSources(async (url, options) => {
      const headers = new Headers(options?.headers);
      expect(headers.has('authorization')).toBe(false);
      expect(headers.has('cookie')).toBe(false);
      if (String(url).includes('bilibili.com')) return new Response(null, { status: 412 });
      if (String(url).includes('/repos?')) return json([repo('Home2.0')]);
      return json(gh);
    }, () => now);
    expect(result.input.bilibili).toEqual({ status: 'failed', reason: 'upstream-blocked' });
    expect(result.input.github.status).toBe('ok');
    expect(SocialSyncInputSchema.parse({ claimId: 'a4538797-be8c-4814-8f14-e05e0ea69e35', ...result.input })).toBeDefined();
  });
  it('fetches fixed pagination URLs and omits project replacement if a later page fails', async () => {
    const seen: string[] = [];
    const result = await collectSources(async url => {
      seen.push(String(url));
      if (String(url).includes('bilibili.com')) return json(bili);
      if (String(url).includes('page=2')) return new Response(null, { status: 429 });
      if (String(url).includes('/repos?')) return json([repo('first')], { link: '<https://evil.test/private>; rel="next"' });
      return json(gh);
    }, () => now);
    expect(seen.every(url => ['api.github.com', 'api.bilibili.com'].includes(new URL(url).hostname))).toBe(true);
    expect(result.input.github.status === 'ok' && result.input.github.profile.repositories).toBeUndefined();
    expect(result.warnings).toEqual(['github-repositories:rate-limited']);
  });
  it('rejects an untrusted OIDC request URL or runtime before transmitting its request token', async () => {
    const fetcher = vi.fn();
    await expect(oidcToken({ ...environment, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://evil.test/token' }, fetcher)).rejects.toThrow('invalid-response');
    await expect(oidcToken({ ...environment, GITHUB_EVENT_NAME: 'pull_request' }, fetcher)).rejects.toThrow('invalid-response');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('a rejected hourly claim makes no provider requests and no import', async () => {
    const urls: string[] = [];
    const logger = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await syncPublicData(environment, async url => {
        urls.push(String(url));
        return String(url).includes('actions.githubusercontent.com') ? json({ value: 'header.payload.signature' }) : json({ data: { accepted: false } });
      });
      expect(urls).toHaveLength(2);
      expect(urls[1]).toBe('https://xvyin-v3-test.pages.dev/api/v1/internal/social-sync/claim');
    } finally { logger.mockRestore(); }
  });
  it('logs only a fixed failure stage and HTTP status without tokens, request URLs or response bodies', async () => {
    const requestSecret = 'request-token-must-never-appear-in-logs';
    const payloadSecret = 'oidc-payload-value-must-never-appear-in-logs';
    const token = [
      Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ aud: 'https://xvyin.com/public-social-sync', privateDiagnostic: payloadSecret })).toString('base64url'),
      'synthetic-signature-must-not-be-logged',
    ].join('.');
    const responseBody = `private-response-body-must-never-appear-in-logs ${requestSecret} ${token}`;
    const requestedUrls: string[] = [];
    const loggers = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      await expect(syncPublicData({ ...environment, ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestSecret }, async (url, options) => {
        requestedUrls.push(String(url));
        const authorization = new Headers(options?.headers).get('authorization');
        if (new URL(String(url)).hostname.endsWith('.actions.githubusercontent.com')) {
          expect(authorization).toBe(`Bearer ${requestSecret}`);
          return json({ value: token });
        }
        expect(String(url)).toBe('https://xvyin-v3-test.pages.dev/api/v1/internal/social-sync/claim');
        expect(authorization).toBe(`Bearer ${token}`);
        return new Response(responseBody, { status: 403 });
      })).rejects.toThrow('upstream-blocked');
      expect(requestedUrls).toHaveLength(2);
      expect(loggers[3]!.mock.calls).toEqual([[JSON.stringify({ stage: 'claim', reason: 'upstream-blocked', status: 403, diagnostic: { responseType: 'other' } })]]);
      const logged = JSON.stringify(loggers.flatMap(logger => logger.mock.calls));
      for (const forbidden of [requestSecret, token, ...token.split('.'), payloadSecret, responseBody, 'private-response-body-must-never-appear-in-logs', ...requestedUrls]) {
        expect(logged).not.toContain(forbidden);
      }
      expect(logged).not.toMatch(/https?:\/\//u);
    } finally { for (const logger of loggers) logger.mockRestore(); }
  });
  it('exposes only allowlisted site authentication diagnostics and filters malicious error bodies', async () => {
    const secret = 'private-diagnostic-canary-never-log';
    const validBody = JSON.stringify({ error: {
      code: 'SOCIAL_SYNC_UNAUTHORIZED', message: secret,
      fields: { stage: ['signature'], reason: ['invalid-token'], claim: ['aud'], token: [secret] },
      requestUrl: `https://private.invalid/${secret}`,
    } });
    const cases: Array<{ body: string; diagnostic?: Record<string, string>; atIdentity?: boolean; headers?: Record<string, string> }> = [
      { body: validBody, diagnostic: { serverCode: 'SOCIAL_SYNC_UNAUTHORIZED', stage: 'signature', reason: 'invalid-token', claim: 'aud' } },
      { body: JSON.stringify({ error: { code: 'SOCIAL_SYNC_UNAUTHORIZED', message: secret, fields: { stage: [secret], reason: ['mismatch', secret], claim: { aud: secret }, token: [secret] } } }), diagnostic: { serverCode: 'SOCIAL_SYNC_UNAUTHORIZED' } },
      { body: JSON.stringify({ error: { code: secret, message: secret, fields: { stage: ['signature'], reason: ['invalid-token'], claim: ['aud'] } } }) },
      { body: validBody.padEnd(4097, ' ') },
      { body: validBody, atIdentity: true },
      { body: JSON.stringify({ error: { code: 'ORIGIN_REJECTED', message: secret, fields: { stage: ['signature'], reason: [secret] } } }), diagnostic: { serverCode: 'ORIGIN_REJECTED' } },
      { body: JSON.stringify({ error: { code: 'RUNNER_UNAUTHORIZED', message: secret, fields: { stage: ['signature'], reason: [secret] } } }), diagnostic: { serverCode: 'RUNNER_UNAUTHORIZED' } },
      { body: `<html>${secret}</html>`, headers: { 'content-type': 'text/html; charset=utf-8', 'cf-mitigated': 'challenge' }, diagnostic: { responseType: 'html', challenge: 'true' } },
      { body: validBody, headers: { 'content-type': `application/${secret}`, 'cf-mitigated': secret }, diagnostic: { responseType: 'other' } },
    ];
    const loggers = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      for (const sample of cases) {
        for (const logger of loggers) logger.mockClear();
        await expect(syncPublicData(environment, async url => {
          if (!sample.atIdentity && new URL(String(url)).hostname.endsWith('.actions.githubusercontent.com')) return json({ value: 'header.payload.signature' });
          return new Response(sample.body, { status: 403, headers: sample.headers || { 'content-type': 'application/json' } });
        })).rejects.toThrow('upstream-blocked');
        expect(loggers[3]!.mock.calls).toEqual([[JSON.stringify({
          stage: sample.atIdentity ? 'claim-identity' : 'claim', reason: 'upstream-blocked', status: 403,
          ...(sample.atIdentity ? {} : { diagnostic: { responseType: 'json', ...sample.diagnostic } }),
        })]]);
        const logged = JSON.stringify(loggers.flatMap(logger => logger.mock.calls));
        for (const forbidden of [secret, sample.body, environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'header.payload.signature']) expect(logged).not.toContain(forbidden);
        expect(logged).not.toMatch(/https?:\/\//u);
      }
    } finally { for (const logger of loggers) logger.mockRestore(); }
  });
});
