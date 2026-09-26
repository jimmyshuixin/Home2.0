import { cacheRead, cacheWrite, internalCacheHeaders, MAX_PUBLIC_BODY_CACHE_BYTES, publicCacheKey, type PublicReadCache } from './public-read-cache';

interface ObjectMetadata { size: number; httpEtag: string; uploaded: Date }
const second = (date: Date) => Math.floor(date.getTime() / 1000);
function dateValue(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}
function etagMatches(value: string, etag: string, weak: boolean): boolean {
  if (value.trim() === '*') return true;
  // Entity tags may contain commas; splitting on a comma would corrupt them.
  const tags = value.match(/(?:W\/)?"[^"\r\n]*"/gu) || [];
  return tags.some(tag => weak ? tag.replace(/^W\//u, '') === etag.replace(/^W\//u, '') : !tag.startsWith('W/') && tag === etag);
}
function precondition(request: Request, object: ObjectMetadata): 304 | 412 | null {
  const match = request.headers.get('if-match'), none = request.headers.get('if-none-match');
  if (match !== null && !etagMatches(match, object.httpEtag, false)) return 412;
  const unmodified = dateValue(request.headers.get('if-unmodified-since'));
  if (match === null && unmodified !== null && second(object.uploaded) > unmodified) return 412;
  if (none !== null) return etagMatches(none, object.httpEtag, true) ? 304 : null;
  const modified = dateValue(request.headers.get('if-modified-since'));
  return modified !== null && second(object.uploaded) <= modified ? 304 : null;
}
function ifRangeMatches(value: string | null, object: ObjectMetadata): boolean {
  if (value === null) return true;
  if (value.startsWith('"') || value.startsWith('W/')) return value === object.httpEtag && !value.startsWith('W/');
  const date = dateValue(value); return date !== null && second(object.uploaded) === date;
}
function objectHeaders(object: ObjectMetadata, contentType: string, privateView: boolean, releaseId: string): Headers {
  const headers = new Headers({ 'content-type': contentType, 'etag': object.httpEtag, 'last-modified': object.uploaded.toUTCString(), 'x-content-type-options': 'nosniff', 'x-xvyin-release': releaseId, 'accept-ranges': 'bytes', 'cache-control': privateView ? 'private, no-store' : 'public, max-age=0, must-revalidate', 'referrer-policy': 'strict-origin-when-cross-origin' });
  if (privateView) { headers.set('x-xvyin-preview', 'true'); headers.set('x-robots-tag', 'noindex, nofollow, noarchive'); headers.set('vary', 'Cookie'); }
  if (contentType.startsWith('text/html')) {
    headers.set('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' blob: https:; font-src 'self'; connect-src 'self'; frame-src 'self' https://player.bilibili.com https://www.youtube-nocookie.com https://open.douyin.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    headers.set('x-frame-options', 'DENY');
  }
  return headers;
}
function byteRange(header: string, size: number): { offset: number; length: number } | null {
  const [startText = '', endText = ''] = header.slice(6).split('-');
  const start = startText ? Number(startText) : null, end = endText ? Number(endText) : null;
  if (start !== null) {
    if (!Number.isSafeInteger(start) || start >= size || end !== null && (!Number.isSafeInteger(end) || end < start)) return null;
    return { offset: start, length: Math.min(end ?? size - 1, size - 1) - start + 1 };
  }
  if (end === null || !Number.isSafeInteger(end) || end <= 0 || size === 0) return null;
  const length = Math.min(end, size); return { offset: size - length, length };
}
async function cancel(response: Response | undefined): Promise<void> { await response?.body?.cancel().catch(() => {}); }

export async function serveObject(bucket: R2Bucket, key: string, request: Request, contentType: string, privateView: boolean, releaseId: string, publicCache?: PublicReadCache): Promise<Response> {
  const cache = privateView ? undefined : publicCache;
  const rangeHeader = request.method === 'GET' ? request.headers.get('range') : null;
  if (rangeHeader && !/^bytes=(?:\d+-\d*|-\d+)$/u.test(rangeHeader)) return new Response(null, { status: 416, headers: { 'cache-control': 'no-store' } });
  const cacheKey = cache && publicCacheKey(cache, releaseId, 'body', key);
  let hit = cacheKey ? await cacheRead(cache, cacheKey) : undefined;
  let metadata: ObjectMetadata | null = null;
  if (hit) {
    // Keep explicit metadata too: an intermediary may frame the cached stream
    // without Content-Length. It must never turn a missing header into size 0.
    const storedSize = hit.headers.get('x-xvyin-object-size'), size = Number(storedSize), etag = hit.headers.get('etag'), uploaded = new Date(hit.headers.get('last-modified') || '');
    if (hit.status === 200 && storedSize !== null && Number.isSafeInteger(size) && size >= 0 && size <= MAX_PUBLIC_BODY_CACHE_BYTES && etag && Number.isFinite(uploaded.getTime())) metadata = { size, httpEtag: etag, uploaded };
    else { await cancel(hit); hit = undefined; }
  }
  const needsMetadata = request.method === 'HEAD' || Boolean(rangeHeader) || ['if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'].some(name => request.headers.has(name));
  if (!metadata && needsMetadata) metadata = await bucket.head(key);
  if (!metadata && needsMetadata) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  let range: { offset: number; length: number } | undefined;
  if (metadata) {
    const headers = objectHeaders(metadata, contentType, privateView, releaseId), status = precondition(request, metadata);
    if (status) { await cancel(hit); return new Response(null, { status, headers }); }
    if (request.method === 'HEAD') { await cancel(hit); headers.set('content-length', String(metadata.size)); return new Response(null, { headers }); }
    if (rangeHeader && ifRangeMatches(request.headers.get('if-range'), metadata)) {
      const parsed = byteRange(rangeHeader, metadata.size);
      if (!parsed) { await cancel(hit); headers.set('content-range', `bytes */${metadata.size}`); headers.set('cache-control', 'no-store'); return new Response(null, { status: 416, headers }); }
      range = parsed;
    }
    if (hit && cacheKey && range) {
      await cancel(hit);
      hit = await cacheRead(cache, new Request(cacheKey, { headers: { range: `bytes=${range.offset}-${range.offset + range.length - 1}` } }));
      if (hit && (hit.status !== 206 || hit.headers.get('content-range') !== `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`)) { await cancel(hit); hit = undefined; }
    }
    if (hit) {
      headers.set('content-length', String(range?.length ?? metadata.size));
      if (range) headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
      return new Response(hit.body, { status: range ? 206 : 200, headers });
    }
  }
  // A metadata read may be followed by a concurrent overwrite. Bind the stream
  // to that ETag rather than returning bytes from a different object version.
  const object = await bucket.get(key, { ...(metadata ? { onlyIf: { etagMatches: metadata.httpEtag.slice(1, -1) } } : {}), ...(range ? { range } : {}) });
  if (!object) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const headers = objectHeaders(object, contentType, privateView, releaseId);
  if (!('body' in object)) return new Response(null, { status: 412, headers });
  headers.set('content-length', String(range?.length ?? object.size));
  if (range) headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  const response = new Response(object.body, { status: range ? 206 : 200, headers });
  // Cache only an ordinary complete GET. Do not fetch a whole video to warm a
  // range miss, or put a partial response into the full-object cache.
  if (cache && cacheKey && request.method === 'GET' && !rangeHeader && response.status === 200 && object.size <= MAX_PUBLIC_BODY_CACHE_BYTES) {
    const copy = response.clone();
    const stored = new Response(copy.body, { headers: internalCacheHeaders({ 'content-type': contentType, 'content-length': String(object.size), 'x-xvyin-object-size': String(object.size), etag: object.httpEtag, 'last-modified': object.uploaded.toUTCString() }) });
    await cacheWrite(cache, cacheKey, stored);
  }
  return response;
}
