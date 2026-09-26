import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { publicIndex, renderPublic, serveObject } from '../src/render';
import { MAX_PUBLIC_BODY_CACHE_BYTES, publicCacheKey, type PublicReadCache } from '../src/public-read-cache';
import { Releases } from '../src/releases';
import { MemoryStore } from '../src/store/memory';

// Uses real local workerd R2 and Cache API; no external accounts or data.
const origin = 'https://transport.invalid', body = '0123456789-test';
let mf: Miniflare, real: R2Bucket, bucket: R2Bucket, context: PublicReadCache, release: string;
let reads: string[], heads: string[], writes: number, matches: number;
const request = (headers: Record<string, string> = {}, method = 'GET') => new Request(`${origin}/public-file`, { headers, method });
const serve = (headers: Record<string, string> = {}, method = 'GET', cache: PublicReadCache | undefined = context, privateView = false) => serveObject(bucket, 'test-object', request(headers, method), 'video/mp4', privateView, release, cache);

beforeAll(async () => {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("transport test"); } }', compatibilityDate: '2026-09-11', r2Buckets: ['MEDIA'] }), telemetry: { enabled: false }, cf: false });
  real = await mf.getR2Bucket('MEDIA') as unknown as R2Bucket;
});
beforeEach(async () => {
  release = crypto.randomUUID(); reads = []; heads = []; writes = 0; matches = 0;
  bucket = new Proxy(real, { get(target, property) {
    if (property === 'get') return (...args: Parameters<R2Bucket['get']>) => { reads.push(args[0]); return target.get(...args); };
    if (property === 'head') return (key: string) => { heads.push(key); return target.head(key); };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const storage = await mf.getCaches(), cache = await storage.open(`test-${release}`);
  context = { origin, cache: {
    // Materialize only this small test fixture across Miniflare's Node bridge.
    // Cancelling a bridged workerd stream triggers an upstream alpha-runtime
    // writer.abort error; real Cache API lookup/range evaluation still run there.
    match: (async (...args: Parameters<Cache['match']>) => {
      matches++; const response = await cache.match(...args as Parameters<typeof cache.match>);
      return response && new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    }) as Cache['match'],
    put: (async (...args: Parameters<Cache['put']>) => { writes++; return cache.put(...args as unknown as Parameters<typeof cache.put>); }) as Cache['put'],
  } };
  await real.put('test-object', body);
});
afterAll(async () => { await mf.dispose(); });

it('allows only the two fixed video-player origins in HTML, including private previews', async () => {
  for (const preview of [false, true]) {
    const result = await serveObject(bucket, 'test-object', request(), 'text/html; charset=utf-8', preview, release, context);
    const csp = result.headers.get('content-security-policy')!;
    expect(csp.split(';').map(value => value.trim()).find(value => value.startsWith('frame-src '))).toBe("frame-src 'self' https://player.bilibili.com https://www.youtube-nocookie.com");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(result.headers.get('x-frame-options')).toBe('DENY');
    await result.text();
  }
});

describe('immutable public edge cache with current-publication checks', () => {
  it('caches only the complete small body and keeps browser revalidation mandatory', async () => {
    const first = await serve(); expect(await first.text()).toBe(body);
    expect(first.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(first.headers.get('last-modified')).toBeTruthy(); expect(writes).toBe(1);
    reads = []; const next = await serve(); expect(await next.text()).toBe(body);
    expect(reads).toEqual([]); expect(heads).toEqual([]); expect(writes).toBe(1);
    const other = await serveObject(bucket, 'test-object', request(), 'video/mp4', false, 'another-release', context);
    expect(await other.text()).toBe(body); expect(reads).toEqual(['test-object']);
    const key = publicCacheKey(context, release, 'body', 'test-object');
    expect(key.headers.has('cookie')).toBe(false); expect(key.url).toContain('/body/');
  });

  it('serves real cached byte ranges and never confuses a range with a complete object', async () => {
    const cold = await serve({ range: 'bytes=2-5' });
    expect(cold.status).toBe(206); expect(await cold.text()).toBe('2345'); expect(writes).toBe(0);
    expect(heads).toEqual(['test-object']); expect(reads).toEqual(['test-object']);
    expect(await (await serve()).text()).toBe(body); reads = []; heads = [];
    for (const [range, expected, contentRange] of [['bytes=2-5', '2345', 'bytes 2-5/15'], ['bytes=-4', 'test', 'bytes 11-14/15'], ['bytes=11-999', 'test', 'bytes 11-14/15']]) {
      const result = await serve({ range: range! }); expect(result.status).toBe(206);
      expect(await result.text()).toBe(expected); expect(result.headers.get('content-range')).toBe(contentRange);
    }
    expect(reads).toEqual([]); expect(heads).toEqual([]); expect(writes).toBe(1);
    expect(await (await serve()).text()).toBe(body);
  });

  it.each([false, true])('evaluates validators and precedence consistently, cached=%s', async cached => {
    const first = await serveObject(bucket, 'test-object', request(), 'video/mp4', false, release, cached ? context : undefined); await first.text();
    const fetch = (headers: Record<string, string>, method = 'GET') => serveObject(bucket, 'test-object', request(headers, method), 'video/mp4', false, release, cached ? context : undefined);
    const etag = first.headers.get('etag')!, date = first.headers.get('last-modified')!;
    for (const headers of [{ 'if-none-match': etag }, { 'if-none-match': `W/${etag}` }, { 'if-none-match': `"other", ${etag}` }, { 'if-none-match': '*' }, { 'if-modified-since': date }] as Record<string, string>[]) {
      const result = await fetch(headers); expect(result.status, JSON.stringify(headers)).toBe(304); expect(await result.text()).toBe('');
    }
    for (const headers of [{ 'if-match': '"other"' }, { 'if-match': `W/${etag}` }, { 'if-unmodified-since': 'Thu, 01 Jan 1970 00:00:00 GMT' }, { 'if-match': '"other"', 'if-none-match': etag }] as Record<string, string>[]) {
      expect((await fetch(headers)).status, JSON.stringify(headers)).toBe(412);
    }
    for (const headers of [{ 'if-none-match': '"other"', 'if-modified-since': date }, { 'if-match': etag, 'if-unmodified-since': 'Thu, 01 Jan 1970 00:00:00 GMT' }, { 'if-modified-since': 'invalid' }] as Record<string, string>[]) {
      const result = await fetch(headers); expect(result.status).toBe(200); expect(await result.text()).toBe(body);
    }
    for (const condition of [etag, date]) {
      const result = await fetch({ range: 'bytes=2-5', 'if-range': condition }); expect(result.status).toBe(206); expect(await result.text()).toBe('2345');
    }
    for (const condition of [`W/${etag}`, '"other"', 'Thu, 01 Jan 1970 00:00:00 GMT', 'Thu, 01 Jan 2099 00:00:00 GMT', 'invalid']) {
      const result = await fetch({ range: 'bytes=2-5', 'if-range': condition }); expect(result.status).toBe(200); expect(await result.text()).toBe(body);
    }
    expect((await fetch({ range: 'bytes=2-5', 'if-none-match': etag })).status).toBe(304);
  });

  it('uses metadata only for HEAD and ignores its Range without returning a body', async () => {
    const head = await serve({ range: 'bytes=2-5' }, 'HEAD');
    expect(head.status).toBe(200); expect(head.headers.get('content-length')).toBe(String(body.length)); expect(await head.text()).toBe('');
    expect(reads).toEqual([]); expect(heads).toEqual(['test-object']); expect(writes).toBe(0);
    await (await serve()).text(); reads = []; heads = [];
    expect((await serve({}, 'HEAD')).status).toBe(200); expect(reads).toEqual([]); expect(heads).toEqual([]);
  });

  it('rejects malformed and unsatisfiable ranges before reading any body', async () => {
    for (const range of ['bytes=abc', 'bytes=0-2,5-7', 'bytes=100-200', 'bytes=15-', 'bytes=-0', 'bytes=5-2', 'bytes=9007199254740992-']) {
      const result = await serve({ range }); expect(result.status, range).toBe(416);
      expect(await result.text()).toBe(''); if (range === 'bytes=100-200') expect(result.headers.get('content-range')).toBe('bytes */15');
    }
    expect(reads).toEqual([]); expect(writes).toBe(0);
  });

  it('never caches or shares private originals and previews, including a previously warm public key', async () => {
    await (await serve()).text(); reads = []; matches = 0; writes = 0;
    const result = await serve({}, 'GET', context, true); expect(await result.text()).toBe(body);
    expect(result.headers.get('cache-control')).toBe('private, no-store'); expect(result.headers.get('vary')).toBe('Cookie');
    expect(matches).toBe(0); expect(writes).toBe(0); expect(reads).toEqual(['test-object']);
  });

  it('streams large objects and cold ranges without cloning or filling the whole-object cache', async () => {
    await real.put('test-object', new Uint8Array(MAX_PUBLIC_BODY_CACHE_BYTES + 1));
    const result = await serve(); expect((await result.arrayBuffer()).byteLength).toBe(MAX_PUBLIC_BODY_CACHE_BYTES + 1);
    const range = await serve({ range: 'bytes=0-1023' }); expect(range.status).toBe(206); expect((await range.arrayBuffer()).byteLength).toBe(1024);
    expect(writes).toBe(0);
  });

  it('treats edge cache faults as misses and preserves successful R2 responses', async () => {
    const broken: PublicReadCache = { origin, cache: { match: vi.fn(async () => { throw new Error('cache unavailable'); }), put: vi.fn(async () => { throw new Error('cache unavailable'); }) } };
    const result = await serve({}, 'GET', broken); expect(result.status).toBe(200); expect(await result.text()).toBe(body);
  });

  it('tracks a bounded background cache fill through the request execution context', async () => {
    const pending: Promise<unknown>[] = [];
    const result = await serve({}, 'GET', { ...context, waitUntil: promise => { pending.push(promise); } });
    expect(await result.text()).toBe(body); expect(pending).toHaveLength(1); await Promise.all(pending);
    reads = []; expect(await (await serve()).text()).toBe(body); expect(reads).toEqual([]);
  });

  it('fails a concurrent object overwrite between metadata and conditional body retrieval', async () => {
    const before = await real.head('test-object');
    const racing = new Proxy(bucket, { get(target, property) {
      if (property === 'head') return async (key: string) => { const previous = await target.head(key); await real.put(key, 'changed object'); return previous; };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const result = await serveObject(racing, 'test-object', request({ 'if-match': before!.httpEtag }), 'video/mp4', false, release);
    expect(result.status).toBe(412); expect(await result.text()).toBe('');
  });

  it('bounds the cold public lookup path and ignores validators on an unknown route', async () => {
    const releases = new Releases(new MemoryStore(), bucket, Date.now, 'a'.repeat(40));
    const key = `releases/${release}/files/404.html`, markup = '<html>test missing page</html>';
    await real.put(key, markup);
    await real.put(`releases/${release}/public-index/files/404.html.json`, JSON.stringify({ key, path: '/404.html', contentType: 'text/html' }));
    await real.put('active-release.json', JSON.stringify({ schemaVersion: 1, releaseId: release }));
    const result = await renderPublic(releases, new Request(`${origin}/photography/missing`, { headers: { 'if-none-match': '*', range: 'bytes=0-2' } }), null, context);
    expect(result.status).toBe(404); expect(await result.text()).toBe(markup);
    expect(reads.length + heads.length).toBe(6); expect(matches + writes).toBe(10);
    expect(reads.length + heads.length + matches + writes).toBe(16);
  });

  it('retains a fresh active pointer check and cannot serve cached HTML after a release removes the route', async () => {
    const releases = new Releases(new MemoryStore(), bucket, Date.now, 'a'.repeat(40));
    const fileKey = `releases/${release}/files/index.html`;
    await real.put(fileKey, '<html>published test</html>');
    await real.put(`releases/${release}/public-index/files/index.html.json`, JSON.stringify({ key: fileKey, path: '/index.html', contentType: 'text/html' }));
    await real.put('active-release.json', JSON.stringify({ schemaVersion: 1, releaseId: release }));
    const first = await renderPublic(releases, new Request(`${origin}/`), null, context); expect(await first.text()).toContain('published test');
    reads = []; await (await renderPublic(releases, new Request(`${origin}/`), null, context)).text();
    expect(reads).toEqual(['active-release.json']);
    await real.put('active-release.json', JSON.stringify({ schemaVersion: 1, releaseId: 'new-release' }));
    const removed = await renderPublic(releases, new Request(`${origin}/`), null, context); expect(removed.status).toBe(404); expect(await removed.text()).not.toContain('published test');
  });

  it('caches immutable index hits/misses by release but leaves uncached candidate indexes observable', async () => {
    const releases = new Releases(new MemoryStore(), bucket, Date.now, 'a'.repeat(40));
    const path = 'media/test/content', key = `releases/${release}/public-index/${path}.json`;
    expect(await publicIndex(releases, release, path, context)).toBeNull(); reads = [];
    expect(await publicIndex(releases, release, path, context)).toBeNull(); expect(reads).toEqual([]);
    await real.put(key, JSON.stringify({ key: 'private-candidate' }));
    expect(await publicIndex(releases, release, path)).toEqual({ key: 'private-candidate' });
  });
});
