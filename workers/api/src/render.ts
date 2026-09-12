import { assert } from './errors';
import type { Releases, BuildFile } from './releases';
export async function publicIndex<T>(releases: Releases, id: string, path: string): Promise<T | null> {
  const object = await releases.bucket.get(`releases/${id}/public-index/${path}.json`);
  if (!object) return null;
  assert(object.size <= 4096, 'RELEASE_INTEGRITY', 503, '公开索引无效'); return object.json<T>();
}
export async function serveObject(bucket: R2Bucket, key: string, request: Request, contentType: string, privateView: boolean, releaseId: string): Promise<Response> {
  const rangeHeader = request.method === 'GET' ? request.headers.get('range') : null;
  if (rangeHeader && !/^bytes=(?:\d+-\d*|-\d+)$/u.test(rangeHeader)) return new Response(null, { status: 416, headers: { 'cache-control': 'no-store' } });
  let useRange = Boolean(rangeHeader);
  if (useRange && request.headers.has('if-range')) {
    const head = await bucket.head(key), condition = request.headers.get('if-range');
    useRange = Boolean(head && (condition === head.httpEtag || condition && !condition.startsWith('W/') && Number.isFinite(Date.parse(condition)) && head.uploaded.getTime() <= Date.parse(condition)));
  }
  const object = await bucket.get(key, { onlyIf: request.headers, ...(useRange ? { range: request.headers } : {}) });
  if (!object) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const headers = new Headers({ 'content-type': contentType, 'etag': object.httpEtag, 'x-content-type-options': 'nosniff', 'x-xvyin-release': releaseId, 'accept-ranges': 'bytes', 'cache-control': privateView ? 'private, no-store' : 'public, max-age=0, must-revalidate', 'referrer-policy': 'strict-origin-when-cross-origin' });
  if (privateView) { headers.set('x-xvyin-preview', 'true'); headers.set('x-robots-tag', 'noindex, nofollow, noarchive'); headers.set('vary', 'Cookie'); }
  if (!('body' in object)) return new Response(null, { status: request.headers.has('if-none-match') ? 304 : 412, headers });
  if (useRange && rangeHeader) {
    const [startText = '', endText = ''] = rangeHeader.slice(6).split('-');
    const start = startText ? Number(startText) : null, end = endText ? Number(endText) : null;
    const invalid = start !== null ? !Number.isSafeInteger(start) || start >= object.size || end !== null && (!Number.isSafeInteger(end) || end < start) : end === null || !Number.isSafeInteger(end) || end <= 0 || object.size === 0;
    if (invalid) { await object.body.cancel(); headers.set('content-range', `bytes */${object.size}`); headers.set('cache-control', 'no-store'); return new Response(null, { status: 416, headers }); }
  }
  let status = 200;
  if (useRange && object.range) {
    const range = object.range;
    const offset = 'offset' in range ? range.offset || 0 : 'suffix' in range ? Math.max(0, object.size - range.suffix) : 0;
    const length = Math.min(object.size - offset, 'length' in range && range.length !== undefined ? range.length : object.size - offset);
    if (offset >= object.size || length <= 0) { await object.body.cancel(); headers.set('content-range', `bytes */${object.size}`); headers.set('cache-control', 'no-store'); return new Response(null, { status: 416, headers }); }
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`); headers.set('content-length', String(length)); status = 206;
  } else headers.set('content-length', String(object.size));
  if (contentType.startsWith('text/html')) {
    headers.set('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' blob: https:; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    headers.set('x-frame-options', 'DENY');
  }
  return new Response(request.method === 'HEAD' ? null : object.body, { status, headers });
}
export async function renderPublic(releases: Releases, request: Request, previewId: string | null = null): Promise<Response> {
  const active = previewId ? null : await releases.active(), id = previewId || active?.value.releaseId;
  if (!id) return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>内容尚未发布 · 虚宁</title><body><main><h1>内容尚未发布</h1><p>管理员完成首次发布后，网站将在这里显示。</p></main></body></html>', { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '3600' } });
  const url = new URL(request.url);
  if (!/^\/[A-Za-z0-9_\-./%]*$/u.test(url.pathname) || url.pathname.includes('..') || url.pathname.includes('//') || /%(?:2f|5c|2e|00)/iu.test(url.pathname) || url.pathname.length > 500) return new Response('Not found', { status: 404 });
  const alias = url.pathname.startsWith('/creations/') || url.pathname.startsWith('/photography/') ? await publicIndex<{ location: string }>(releases, id, `aliases${url.pathname}`) : null;
  if (alias) return new Response(null, { status: 308, headers: { location: alias.location, 'cache-control': previewId ? 'private, no-store' : 'no-cache' } });
  const path = url.pathname === '/' ? '/index.html' : url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
  const file = await publicIndex<BuildFile>(releases, id, `files${path}`) || (!path.endsWith('/index.html') && !/\.[A-Za-z0-9]+$/u.test(path) ? await publicIndex<BuildFile>(releases, id, `files${path}/index.html`) : null);
  if (!file) {
    const fallback = await publicIndex<BuildFile>(releases, id, 'files/404.html');
    if (fallback) { const response = await serveObject(releases.bucket, fallback.key, request, fallback.contentType, Boolean(previewId), id); return new Response(response.body, { status: 404, headers: response.headers }); }
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  const response = await serveObject(releases.bucket, file.key, request, file.contentType, Boolean(previewId), id);
  if (previewId && file.contentType.startsWith('text/html') && response.status === 200 && request.method !== 'HEAD') {
    response.headers.delete('content-length');
    return new HTMLRewriter().on('body', { element(element) { element.prepend('<aside style="position:sticky;top:0;z-index:2147483647;padding:12px;background:#9c3b2c;color:#fff;text-align:center">管理员私密预览 · 尚未公开 <a href="/admin/" style="color:inherit;text-decoration:underline">返回后台并退出预览</a></aside>', { html: true }); } }).transform(response);
  }
  return response;
}
