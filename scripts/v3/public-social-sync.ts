/** Dependency-free Node runner. Provider requests are always anonymous; OIDC is only sent to this site. */
import { pathToFileURL } from 'node:url';
import type { BilibiliProfile, GitHubProfile, GitHubRepository, SocialSyncInput } from '@xvyin/contracts';

// Existing Pages gateway reaches the same API Worker without the custom domain's browser-only challenge.
const ORIGIN = 'https://xvyin-v3-test.pages.dev';
const AUDIENCE = 'https://xvyin.com/public-social-sync';
const REPOSITORY = 'jimmyshuixin/Home2.0';
const LOGIN = 'jimmyshuixin';
const USER_ID = 121843277;
type Failure = 'timeout' | 'network' | 'upstream-blocked' | 'invalid-response' | 'rate-limited' | 'unavailable';
type Fetcher = typeof fetch;
type Environment = Readonly<Record<string, string | undefined>>;
class SyncError extends Error {
  readonly reason: Failure;
  readonly status?: number;
  readonly diagnostic?: Record<string, string>;
  constructor(reason: Failure, status?: number, diagnostic?: Record<string, string>) { super(reason); this.reason = reason; this.status = status; this.diagnostic = diagnostic; }
}
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
function text(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  return Array.from(value.replace(/<[^>]*>/gu, '').replace(/[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim()).slice(0, maximum).join('') || null;
}
const reason = (error: unknown): Failure => error instanceof SyncError ? error.reason : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'network';

export async function requestJson(url: string, options: RequestInit = {}, maximum = 128 * 1024, fetcher: Fetcher = fetch): Promise<{ data: unknown; headers: Headers }> {
  const signal = AbortSignal.timeout(15_000);
  let response: Response;
  try { response = await fetcher(url, { ...options, redirect: 'manual', signal, headers: { accept: 'application/json', 'user-agent': 'xvyin-public-sync/1.0', ...options.headers } }); }
  catch (error) { throw new SyncError(reason(error)); }
  if (response.status !== 200) {
    const diagnostic: Record<string, string> = {};
    if (new URL(url).origin === ORIGIN) {
      diagnostic.responseType = response.headers.get('content-type')?.startsWith('text/html') ? 'html' : response.headers.get('content-type')?.startsWith('application/json') ? 'json' : 'other';
      if (response.headers.get('cf-mitigated') === 'challenge') diagnostic.challenge = 'true';
    }
    if (new URL(url).origin === ORIGIN && response.headers.get('content-type')?.startsWith('application/json')) {
      try {
        const parsed = await requestJson(ORIGIN, {}, 4096, async () => new Response(response.body, { status: 200, headers: response.headers }));
        const failure = record(record(parsed.data)?.error), fields = record(failure?.fields);
        if (['ORIGIN_REJECTED', 'RUNNER_UNAUTHORIZED'].includes(String(failure?.code))) diagnostic.serverCode = String(failure?.code);
        if (failure?.code === 'SOCIAL_SYNC_UNAUTHORIZED') {
          diagnostic.serverCode = 'SOCIAL_SYNC_UNAUTHORIZED';
          for (const key of ['stage', 'reason', 'claim']) {
          const value = fields?.[key];
          if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string' && ['signature', 'repository', 'source', 'workflow', 'identity', 'claim', 'jwks-fetch', 'timeout', 'no-key', 'invalid-token', 'invalid-key', 'unsupported', 'unknown', 'mismatch', 'iss', 'aud', 'nbf', 'iat', 'exp', 'sub'].includes(value[0])) diagnostic[key] = value[0];
          }
        }
      } catch { /* Never expose an untrusted error body. */ }
    } else await response.body?.cancel();
    throw new SyncError(response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' ? 'rate-limited' : [403, 412].includes(response.status) ? 'upstream-blocked' : 'unavailable', response.status, Object.keys(diagnostic).length ? diagnostic : undefined);
  }
  const length = response.headers.get('content-length');
  if (!response.body || (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum))) {
    await response.body?.cancel(); throw new SyncError('invalid-response');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, body = '';
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maximum) throw new SyncError('invalid-response');
      body += decoder.decode(item.value, { stream: true });
    }
    return { data: JSON.parse(body + decoder.decode()) as unknown, headers: response.headers };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw new SyncError(signal.aborted ? 'timeout' : error instanceof SyncError ? error.reason : 'invalid-response');
  } finally { reader.releaseLock(); }
}

export function bilibiliProfile(value: unknown, capturedAt: number): BilibiliProfile {
  const root = record(value), data = record(root?.data), card = record(data?.card);
  if (root?.code !== 0 || !card || String(card.mid) !== '520237303') throw new SyncError('invalid-response');
  const name = text(card.name, 80);
  if (!name) throw new SyncError('invalid-response');
  const avatar = typeof card.face === 'string' ? card.face.replace(/^http:\/\//u, 'https://') : '';
  return {
    uid: '520237303', profileUrl: 'https://space.bilibili.com/520237303', name, signature: text(card.sign, 500),
    avatarUrl: avatar.length <= 512 && /^https:\/\/i[012]\.hdslb\.com\/bfs\/face\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:jpe?g|png|webp)$/iu.test(avatar) ? avatar : null,
    followers: count(data?.follower), videoCount: count(data?.archive_count), likes: count(data?.like_num),
    updatedAt: new Date(capturedAt).toISOString(), status: 'fresh', authorization: 'public',
  };
}

export function githubProfile(value: unknown, capturedAt: number): GitHubProfile {
  const source = record(value);
  if (source?.id !== USER_ID || source.login !== LOGIN || source.type !== 'User' || source.html_url !== `https://github.com/${LOGIN}`) throw new SyncError('invalid-response');
  return {
    id: USER_ID, login: LOGIN, profileUrl: `https://github.com/${LOGIN}`,
    name: text(source.name, 80), bio: text(source.bio, 500),
    avatarUrl: typeof source.avatar_url === 'string' && /^https:\/\/avatars\.githubusercontent\.com\/u\/121843277(?:\?v=4)?$/u.test(source.avatar_url) ? source.avatar_url : null,
    publicRepos: count(source.public_repos), followers: count(source.followers), following: count(source.following),
    updatedAt: new Date(capturedAt).toISOString(), status: 'fresh', authorization: 'public',
  };
}

export function githubRepositories(values: unknown[], capturedAt: number): GitHubRepository[] {
  const selected = new Map<string, GitHubRepository>();
  for (const value of values) {
    const repo = record(value), owner = record(repo?.owner);
    if (!repo || repo.private !== false || repo.fork !== false || (repo.visibility !== undefined && repo.visibility !== 'public') || owner?.id !== USER_ID || owner.login !== LOGIN) continue;
    const name = repo.name;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/u.test(name) || ['.', '..'].includes(name) || repo.html_url !== `https://github.com/${LOGIN}/${name}`) throw new SyncError('invalid-response');
    const stars = count(repo.stargazers_count), forks = count(repo.forks_count);
    if (stars === null || forks === null) throw new SyncError('invalid-response');
    const pushed = typeof repo.pushed_at === 'string' ? Date.parse(repo.pushed_at) : NaN;
    selected.set(name.toLowerCase(), {
      name, url: `https://github.com/${LOGIN}/${name}`, description: text(repo.description, 500), language: text(repo.language, 80), stars, forks,
      pushedAt: Number.isFinite(pushed) && pushed <= capturedAt ? new Date(pushed).toISOString() : null,
    });
  }
  return [...selected.values()].sort((a, b) => (b.pushedAt || '').localeCompare(a.pushedAt || '') || b.stars - a.stars || a.name.localeCompare(b.name)).slice(0, 6);
}

export async function collectSources(fetcher: Fetcher = fetch, now: () => number = Date.now): Promise<{ input: Omit<SocialSyncInput, 'claimId'>; warnings: string[] }> {
  const warnings: string[] = [];
  const bilibili = async (): Promise<SocialSyncInput['bilibili']> => {
    try {
      const result = await requestJson('https://api.bilibili.com/x/web-interface/card?mid=520237303', {}, 64 * 1024, fetcher);
      return { status: 'ok', profile: bilibiliProfile(result.data, now()) };
    } catch (error) { return { status: 'failed', reason: reason(error) }; }
  };
  const github = async (): Promise<SocialSyncInput['github']> => {
    try {
      const result = await requestJson(`https://api.github.com/users/${LOGIN}`, {}, 64 * 1024, fetcher);
      const profile = githubProfile(result.data, now());
      try {
        const all: unknown[] = [];
        // Follow the endpoint's pagination indication, constructing each URL locally.
        for (let page = 1; page <= 10; page++) {
          const response = await requestJson(`https://api.github.com/users/${LOGIN}/repos?type=owner&sort=full_name&direction=asc&per_page=100&page=${page}`, {}, 2 * 1024 * 1024, fetcher);
          if (!Array.isArray(response.data) || response.data.length > 100) throw new SyncError('invalid-response');
          all.push(...response.data);
          if (!/rel="next"/u.test(response.headers.get('link') || '')) break;
          if (page === 10) throw new SyncError('unavailable');
        }
        profile.repositories = githubRepositories(all, now());
        profile.repositoriesUpdatedAt = new Date(now()).toISOString();
      } catch (error) { warnings.push(`github-repositories:${reason(error)}`); }
      return { status: 'ok', profile };
    } catch (error) { return { status: 'failed', reason: reason(error) }; }
  };
  const [bili, gh] = await Promise.all([bilibili(), github()]);
  return { input: { bilibili: bili, github: gh }, warnings };
}

export async function oidcToken(environment: Environment, fetcher: Fetcher = fetch): Promise<string> {
  if (environment.GITHUB_REPOSITORY !== REPOSITORY || environment.GITHUB_REF !== 'refs/heads/main' || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new SyncError('invalid-response');
  const requestUrl = environment.ACTIONS_ID_TOKEN_REQUEST_URL, requestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) throw new SyncError('unavailable');
  const url = new URL(requestUrl);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.actions\.githubusercontent\.com$/u.test(url.hostname) || url.username || url.password || url.port || url.hash) throw new SyncError('invalid-response');
  url.searchParams.set('audience', AUDIENCE);
  const result = await requestJson(url.href, { headers: { authorization: `Bearer ${requestToken}` } }, 32 * 1024, fetcher);
  const token = record(result.data)?.value;
  if (typeof token !== 'string' || token.length > 16000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) throw new SyncError('invalid-response');
  return token;
}

export async function syncPublicData(environment: Environment = process.env, fetcher: Fetcher = fetch): Promise<void> {
  // Fixed stage names and HTTP status only: never log request URLs, headers, tokens or response bodies.
  let stage = 'claim-identity';
  try {
    const claimToken = await oidcToken(environment, fetcher);
    // Diagnostic booleans are not authorization; the server independently verifies the signature and every claim.
    try {
      const claims = record(JSON.parse(Buffer.from(claimToken.split('.')[1]!, 'base64url').toString('utf8')));
      const timestamp = Math.floor(Date.now() / 1000);
      console.log(JSON.stringify({ identityChecks: {
        repository: claims?.repository === REPOSITORY && claims?.repository_id === '1252970286',
        owner: claims?.repository_owner === LOGIN && claims?.repository_owner_id === String(USER_ID),
        public: claims?.repository_visibility === 'public',
        subject: [`repo:${REPOSITORY}:ref:refs/heads/main`, `repo:${LOGIN}@${USER_ID}/Home2.0@1252970286:ref:refs/heads/main`].includes(String(claims?.sub)),
        audience: claims?.aud === AUDIENCE, issuer: claims?.iss === 'https://token.actions.githubusercontent.com',
        ref: claims?.ref === 'refs/heads/main' && claims?.ref_type === 'branch',
        event: claims?.event_name === 'workflow_dispatch', runner: claims?.runner_environment === 'github-hosted',
        workflow: claims?.workflow_ref === `${REPOSITORY}/.github/workflows/public-social-sync.yml@refs/heads/main`,
        sha: typeof claims?.sha === 'string' && /^[a-f0-9]{40}$/u.test(claims.sha) && claims.workflow_sha === claims.sha,
        direct: claims?.job_workflow_ref === undefined,
        jobRefIsSameWorkflow: claims?.job_workflow_ref === claims?.workflow_ref,
        jobShaIsSameCommit: claims?.job_workflow_sha === claims?.sha,
        notBefore: typeof claims?.nbf === 'number' && claims.nbf <= timestamp,
        expires: typeof claims?.exp === 'number' && claims.exp > timestamp,
      } }));
    } catch { console.log('Identity diagnostic unavailable.'); }
    stage = 'claim';
    const claimResponse = await requestJson(`${ORIGIN}/api/v1/internal/social-sync/claim`, { method: 'POST', headers: { authorization: `Bearer ${claimToken}` } }, 32 * 1024, fetcher);
    const claim = record(record(claimResponse.data)?.data);
    if (claim?.accepted === false) { console.log('Public social refresh already claimed this hour; skipped.'); return; }
    if (claim?.accepted !== true || typeof claim.claimId !== 'string' || !/^[a-f0-9-]{36}$/u.test(claim.claimId)) throw new SyncError('invalid-response');
    stage = 'public-sources';
    const collected = await collectSources(fetcher);
    stage = 'import-identity';
    const importToken = await oidcToken(environment, fetcher);
    stage = 'import';
    const imported = await requestJson(`${ORIGIN}/api/v1/internal/social-sync`, {
      method: 'POST', headers: { authorization: `Bearer ${importToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ claimId: claim.claimId, ...collected.input }),
    }, 32 * 1024, fetcher);
    if (record(record(imported.data)?.data)?.imported !== true) throw new SyncError('invalid-response');
    for (const [platform, result] of Object.entries(collected.input)) {
      console.log(JSON.stringify({ platform, status: result.status, ...(result.status === 'ok' ? { capturedAt: result.profile.updatedAt } : { reason: result.reason }) }));
    }
    for (const warning of collected.warnings) console.warn(warning);
    if (collected.warnings.length || Object.values(collected.input).some(result => result.status === 'failed')) process.exitCode = 1;
    } catch (error) {
    console.error(JSON.stringify({ stage, reason: reason(error), ...(error instanceof SyncError && error.status ? { status: error.status } : {}), ...(error instanceof SyncError && error.diagnostic ? { diagnostic: error.diagnostic } : {}) }));
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncPublicData().catch(error => { console.error(`Public social synchronization failed: ${reason(error)}`); process.exitCode = 1; });
}
