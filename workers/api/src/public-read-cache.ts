/** Optional, best-effort edge storage. Callers must authorize the current
 * publication before looking up a key; this never caches the active pointer. */
export interface PublicReadCache {
  cache: Pick<Cache, 'match' | 'put'>;
  origin: string;
  waitUntil?: (promise: Promise<unknown>) => void;
}

// Bound a background clone to a small object, even when a client reads slowly.
// Large videos and downloads remain direct R2 streams, including cold ranges.
export const MAX_PUBLIC_BODY_CACHE_BYTES = 2 * 1024 * 1024;
const INTERNAL_TTL = 'public, max-age=31536000, immutable';

export function publicCacheKey(context: PublicReadCache, releaseId: string, kind: 'index' | 'body', key: string): Request {
  const origin = new URL(context.origin);
  return new Request(new URL(`/__xvyin_edge/v1/${kind}/${encodeURIComponent(releaseId)}/${encodeURIComponent(key)}`, origin.origin));
}

export async function cacheRead(context: PublicReadCache | undefined, key: Request): Promise<Response | undefined> {
  if (!context) return undefined;
  try { return await context.cache.match(key); } catch { return undefined; }
}

export async function cacheWrite(context: PublicReadCache, key: Request, response: Response): Promise<void> {
  const operation = context.cache.put(key, response).catch(() => { /* Cache eviction/failure must not fail a public read. */ });
  if (context.waitUntil) context.waitUntil(operation);
  else await operation;
}

export function internalCacheHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set('cache-control', INTERNAL_TTL);
  return result;
}
