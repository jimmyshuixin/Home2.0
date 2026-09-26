import { z } from 'zod';
import { BILIBILI_PROFILE_URL, BILIBILI_UID, BilibiliProfileSchema, isBilibiliAvatarUrl, type BilibiliProfile } from '@xvyin/contracts';
import { cacheRead, cacheWrite, publicCacheKey, type PublicReadCache } from './public-read-cache';
import packagedSnapshot from './bilibili-profile-snapshot.json';

const UPSTREAM_URL = `https://api.bilibili.com/x/web-interface/card?mid=${BILIBILI_UID}`;
const FRESH_MS = 60 * 60_000;
const RETAIN_MS = 24 * FRESH_MS;
const BACKOFF_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;
const MAX_UPSTREAM_BYTES = 64 * 1024;
const MAX_CACHE_BYTES = 8 * 1024;
const cachedStateSchema = z.object({ profile: BilibiliProfileSchema.nullable(), checkedAt: z.number().int().nonnegative() }).strict();
type CachedState = z.infer<typeof cachedStateSchema>;

export type BilibiliFetch = (request: Request) => Promise<Response>;
interface ProfileDependencies {
  now: () => number;
  cache?: PublicReadCache;
  fetcher?: BilibiliFetch;
  /** Undefined uses the packaged public snapshot; null explicitly disables it. */
  fallbackSnapshot?: unknown;
}

type FailureReason = 'timeout' | 'network' | 'upstream-http-error' | 'upstream-unavailable' | 'invalid-response';
class ProfileReadError extends Error {
  constructor(readonly reason: FailureReason) { super(reason); }
}

function unavailable(): BilibiliProfile {
  return { uid: BILIBILI_UID, profileUrl: BILIBILI_PROFILE_URL, name: null, signature: null, avatarUrl: null, followers: null, videoCount: null, likes: null, updatedAt: null, status: 'unavailable', authorization: 'public' };
}

function snapshotFallback(value: unknown, now: number): BilibiliProfile {
  const result = BilibiliProfileSchema.safeParse(value);
  if (!result.success || result.data.status !== 'snapshot') return unavailable();
  const capturedAt = Date.parse(result.data.updatedAt || '');
  // This is dated historical public data, never a refreshed cache entry.
  if (!Number.isFinite(capturedAt) || capturedAt > now) return unavailable();
  return result.data;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // Keep remote text inert and bounded, including hidden formatting controls.
  return Array.from(value.replace(/<[^>]*>/gu, '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim()).slice(0, max).join('');
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function avatar(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.replace(/^http:\/\//u, 'https://');
  return isBilibiliAvatarUrl(candidate) ? candidate : null;
}

function publicProfile(value: unknown, now: number): BilibiliProfile {
  const root = record(value), data = record(root?.data), card = record(data?.card);
  if (root && typeof root.code === 'number' && root.code !== 0) throw new ProfileReadError('upstream-unavailable');
  if (root?.code !== 0 || !card || String(card.mid) !== BILIBILI_UID) throw new ProfileReadError('invalid-response');
  const result = BilibiliProfileSchema.safeParse({
    uid: BILIBILI_UID, profileUrl: BILIBILI_PROFILE_URL,
    name: text(card.name, 80), signature: text(card.sign, 500), avatarUrl: avatar(card.face),
    followers: count(data?.follower), videoCount: count(data?.archive_count), likes: count(data?.like_num),
    updatedAt: new Date(now).toISOString(), status: 'fresh', authorization: 'public',
  });
  if (!result.success) throw new ProfileReadError('invalid-response');
  return result.data;
}

async function boundedResponseJson(response: Response, max: number, signal?: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (response.status !== 200 || !response.body || (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > max))) {
    await response.body?.cancel().catch(() => {});
    throw new ProfileReadError(response.status !== 200 ? 'upstream-http-error' : 'invalid-response');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, content = '';
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new ProfileReadError('timeout');
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > max) throw new ProfileReadError('invalid-response');
      content += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(content + decoder.decode()) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof ProfileReadError ? error : new ProfileReadError(signal?.aborted ? 'timeout' : 'invalid-response');
  } finally {
    signal?.removeEventListener('abort', cancel); reader.releaseLock();
  }
}

async function fetchProfile(fetcher: BilibiliFetch, now: () => number): Promise<BilibiliProfile> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ProfileReadError('timeout')); }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([deadline, (async () => {
      // Build a fresh fixed-host request. Visitor cookies, query parameters,
      // authorization headers and IP addresses never reach Bilibili.
      const request = new Request(UPSTREAM_URL, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } });
      const response = await fetcher(request);
      const value = await boundedResponseJson(response, MAX_UPSTREAM_BYTES, controller.signal);
      return publicProfile(value, now());
    })()]);
  } catch (error) {
    throw error instanceof ProfileReadError ? error : new ProfileReadError(controller.signal.aborted ? 'timeout' : 'network');
  } finally { clearTimeout(timer); controller.abort(); }
}

async function cachedState(context: PublicReadCache | undefined, key: Request | undefined, now: number): Promise<CachedState | null> {
  if (!context || !key) return null;
  const response = await cacheRead(context, key);
  if (!response) return null;
  try {
    const state = cachedStateSchema.parse(await boundedResponseJson(response, MAX_CACHE_BYTES));
    if (!Number.isSafeInteger(state.checkedAt) || state.checkedAt > now || now - state.checkedAt >= RETAIN_MS) return null;
    if (state.profile) {
      const updatedAt = Date.parse(state.profile.updatedAt || '');
      if (state.profile.status !== 'fresh' || !Number.isFinite(updatedAt) || updatedAt > state.checkedAt || now - updatedAt >= RETAIN_MS) return null;
    }
    return state;
  } catch { return null; }
}

async function saveState(context: PublicReadCache | undefined, key: Request | undefined, state: CachedState, now: number): Promise<void> {
  if (!context || !key) return;
  const retention = state.profile ? RETAIN_MS - (now - Date.parse(state.profile.updatedAt!)) : BACKOFF_MS;
  if (retention <= 0) return;
  try {
    await cacheWrite(context, key, new Response(JSON.stringify(state), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${Math.max(1, Math.floor(retention / 1000))}` } }));
  } catch { /* Optional edge storage cannot prevent public profile access. */ }
}

/** Public account information only; no OAuth tokens, cookies or database writes. */
export async function readBilibiliProfile({ now, cache, fetcher = request => fetch(request), fallbackSnapshot = packagedSnapshot }: ProfileDependencies): Promise<BilibiliProfile> {
  const instant = now();
  const key = cache ? publicCacheKey(cache, 'bilibili-profile-v1', 'index', BILIBILI_UID) : undefined;
  const state = await cachedState(cache, key, instant);
  const profile = state?.profile;
  if (profile && instant - Date.parse(profile.updatedAt!) < FRESH_MS) return profile;
  if (state && instant - state.checkedAt < BACKOFF_MS) return profile ? { ...profile, status: 'stale' } : snapshotFallback(fallbackSnapshot, instant);
  try {
    const fresh = await fetchProfile(fetcher, now);
    const checkedAt = Date.parse(fresh.updatedAt!);
    await saveState(cache, key, { profile: fresh, checkedAt }, checkedAt);
    return fresh;
  } catch (error) {
    // Only the bounded classification enters logs, never upstream text or data.
    console.warn(JSON.stringify({ level: 'warn', code: 'BILIBILI_PUBLIC_PROFILE_UNAVAILABLE', reason: error instanceof ProfileReadError ? error.reason : 'network' }));
    const checkedAt = now();
    const retained = profile && checkedAt - Date.parse(profile.updatedAt!) < RETAIN_MS ? profile : null;
    await saveState(cache, key, { profile: retained, checkedAt }, checkedAt);
    return retained ? { ...retained, status: 'stale' } : snapshotFallback(fallbackSnapshot, checkedAt);
  }
}
