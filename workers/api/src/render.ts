import { assert } from './errors';
import type { Releases, BuildFile } from './releases';
import { cacheRead, cacheWrite, internalCacheHeaders, publicCacheKey, type PublicReadCache } from './public-read-cache';
import { serveObject } from './public-object';
export { serveObject } from './public-object';

export async function publicIndex<T>(releases: Releases, id: string, path: string, cache?: PublicReadCache): Promise<T | null> {
  const key = `releases/${id}/public-index/${path}.json`, cacheKey = cache && publicCacheKey(cache, id, 'index', key);
  const hit = cacheKey && await cacheRead(cache, cacheKey);
  if (hit) {
    try { return await hit.json() as T | null; } catch { /* Read the authoritative immutable index on a damaged cache entry. */ }
  }
  const object = await releases.bucket.get(key);
  if (object) assert(object.size <= 4096, 'RELEASE_INTEGRITY', 503, '公开索引无效');
  const data = object ? await object.json<T>() : null;
  // Missing aliases/paths are immutable too once a release is public. Private
  // candidate indexes are still being generated and must not use this cache.
  if (cache && cacheKey) await cacheWrite(cache, cacheKey, new Response(JSON.stringify(data), { headers: internalCacheHeaders({ 'content-type': 'application/json' }) }));
  return data;
}

export async function renderPublic(releases: Releases, request: Request, previewId: string | null = null, publicCache?: PublicReadCache): Promise<Response> {
  const active = previewId ? null : await releases.active(), id = previewId || active?.value.releaseId;
  if (!id) return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>内容尚未发布 · 虚宁</title><body><main><h1>内容尚未发布</h1><p>管理员完成首次发布后，网站将在这里显示。</p></main></body></html>', { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '3600' } });
  const cache = previewId ? undefined : publicCache, url = new URL(request.url);
  if (!/^\/[A-Za-z0-9_\-./%]*$/u.test(url.pathname) || url.pathname.includes('..') || url.pathname.includes('//') || /%(?:2f|5c|2e|00)/iu.test(url.pathname) || url.pathname.length > 500) return new Response('Not found', { status: 404 });
  const alias = url.pathname.startsWith('/creations/') || url.pathname.startsWith('/photography/') ? await publicIndex<{ location: string }>(releases, id, `aliases${url.pathname}`, cache) : null;
  if (alias) return new Response(null, { status: 308, headers: { location: alias.location, 'cache-control': previewId ? 'private, no-store' : 'no-cache' } });
  const path = url.pathname === '/' ? '/index.html' : url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
  const file = await publicIndex<BuildFile>(releases, id, `files${path}`, cache) || (!path.endsWith('/index.html') && !/\.[A-Za-z0-9]+$/u.test(path) ? await publicIndex<BuildFile>(releases, id, `files${path}/index.html`, cache) : null);
  if (!file) {
    const fallback = await publicIndex<BuildFile>(releases, id, 'files/404.html', cache);
    if (fallback) {
      // The missing route takes precedence over validators for the shared 404
      // document. A Range or matching ETag must not turn it into an empty error.
      const fallbackRequest = new Request(request.url, { method: request.method });
      const response = await serveObject(releases.bucket, fallback.key, fallbackRequest, fallback.contentType, Boolean(previewId), id, cache);
      return new Response(request.method === 'HEAD' ? null : response.body, { status: 404, headers: response.headers });
    }
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  const response = await serveObject(releases.bucket, file.key, request, file.contentType, Boolean(previewId), id, cache);
  if (previewId && file.contentType.startsWith('text/html') && response.status === 200 && request.method !== 'HEAD') {
    response.headers.delete('content-length');
    return new HTMLRewriter().on('body', { element(element) { element.prepend('<aside style="position:sticky;top:0;z-index:2147483647;padding:12px;background:#9c3b2c;color:#fff;text-align:center">管理员私密预览 · 尚未公开 <a href="/admin/" style="color:inherit;text-decoration:underline">返回后台并退出预览</a></aside>', { html: true }); } }).transform(response);
  }
  return response;
}
