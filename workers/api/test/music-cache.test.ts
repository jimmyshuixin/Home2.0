import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { PlaylistDraftSchema } from '@xvyin/contracts';
import { createMusicHandler } from '../src/music';
import { emptySnapshot, type Snapshot } from '../src/releases';
import { publicCacheKey, type PublicReadCache } from '../src/public-read-cache';

// The QQ nonce page deliberately accepts only the configured site origins.
// Requests remain entirely in this local handler; no URL is fetched live.
const origin = 'https://xvyin.com';
const coverUrl = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000albumMid.jpg';
const tracks = [{ id: '123', songmid: 'mid1', title: 'Explicit test track', pic: coverUrl }];
const path = (suffix: string) => new Request(`${origin}/api/v1/music/${suffix}`);
let mf: Miniflare, context: PublicReadCache, snapshot: Snapshot;
let matches: number, writes: number, playlistRequests: number, streamRequests: number, lyricRequests: number, coverRequests: number;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeAll(async () => {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("music cache test"); } }', compatibilityDate: '2026-09-11' }), telemetry: { enabled: false }, cf: false });
});
beforeEach(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  snapshot = emptySnapshot(crypto.randomUUID());
  snapshot.playlists.push({ ...PlaylistDraftSchema.parse({ name: 'Public test playlist', source: 'tencent', sourceId: '9206816111', enabled: true, isDefault: true }), id: 'qq_main', revisionId: 'revision_test', publishedAt: '2026-09-12T00:00:00.000Z' });
  matches = 0; writes = 0; playlistRequests = 0; streamRequests = 0; lyricRequests = 0; coverRequests = 0;
  const storage = await mf.getCaches(), cache = await storage.open(`music-${snapshot.releaseId}`);
  context = { origin, cache: {
    // Real workerd cache operations with a bounded fixture crossing the Node
    // bridge, avoiding the alpha bridge's cancellation writer.abort failure.
    match: (async (...args: Parameters<Cache['match']>) => {
      matches++; const response = await cache.match(...args as Parameters<typeof cache.match>);
      return response && new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    }) as Cache['match'],
    put: (async (...args: Parameters<Cache['put']>) => { writes++; return cache.put(...args as unknown as Parameters<typeof cache.put>); }) as Cache['put'],
  } };
  fetcher = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    if (url.href === coverUrl) { coverRequests++; return new Response(new Uint8Array([255, 216, 255, 217]), { headers: { 'content-type': 'image/jpeg', 'content-length': '4' } }); }
    if (url.searchParams.get('type') === 'playlist') { playlistRequests++; return Response.json(tracks); }
    if (url.searchParams.get('type') === 'lrc') { lyricRequests++; return Response.json({ lyric: '[00:00.00]Explicit test lyrics' }); }
    if (url.searchParams.get('type') === 'url') { streamRequests++; return Response.json({ url: `https://isure.stream.qqmusic.qq.com/fixture.m4a?token=${streamRequests}` }); }
    throw new Error('Unexpected test upstream');
  });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await mf.dispose(); });
const cacheKey = () => publicCacheKey(context, snapshot.releaseId, 'index', `music-playlist/${snapshot.playlists[0]!.id}/${snapshot.playlists[0]!.source}/${snapshot.playlists[0]!.sourceId}`);

describe('short-lived validated provider playlist cache', () => {
  it('reuses the list for cover, lyrics and browser while rendering fresh nonce pages', async () => {
    const handler = createMusicHandler('https://music.xvyin.com', fetcher, origin, context);
    expect((await (await handler(path('playlist/qq_main'), snapshot, 'req')).json() as any).data[0].id).toBe('123');
    const cover = await handler(path('cover/qq_main/123'), snapshot, 'req'); expect((await cover.arrayBuffer()).byteLength).toBe(4);
    expect(await (await handler(path('lyrics/qq_main/123'), snapshot, 'req')).json()).toMatchObject({ data: { lyrics: '[00:00.00]Explicit test lyrics' } });
    const one = crypto.randomUUID(), two = crypto.randomUUID();
    const first = await handler(path(`browser/qq_main/123?nonce=${one}`), snapshot, 'req');
    const second = await handler(path(`browser/qq_main/123?nonce=${two}`), snapshot, 'req');
    expect(await first.text()).toContain(one); const text = await second.text(); expect(text).toContain(two); expect(text).not.toContain(one);
    expect(first.headers.get('cache-control')).toBe('private, no-store'); expect(second.headers.get('cache-control')).toBe('private, no-store');
    expect(playlistRequests).toBe(1); expect(coverRequests).toBe(1); expect(lyricRequests).toBe(1); expect(writes).toBe(1);
  });

  it('checks current configuration before consulting a warm cache', async () => {
    const handler = createMusicHandler('https://music.xvyin.com', fetcher, origin, context);
    await (await handler(path('playlist/qq_main'), snapshot, 'req')).text(); matches = 0;
    const disabled = structuredClone(snapshot); disabled.playlists[0]!.enabled = false;
    const removed = structuredClone(snapshot); removed.playlists = [];
    for (const value of [disabled, removed]) {
      await expect(handler(path('playlist/qq_main'), value, 'req')).rejects.toMatchObject({ status: 404 });
      await expect(handler(path('browser/qq_main/123?nonce=' + crypto.randomUUID()), value, 'req')).rejects.toMatchObject({ status: 404 });
    }
    expect(matches).toBe(0); expect(playlistRequests).toBe(1);
    await expect(handler(path('stream/qq_main/nonmember'), snapshot, 'req')).rejects.toMatchObject({ status: 404 });
    expect(streamRequests).toBe(0);
  });

  it('keys the list by release, configuration id, source and source id', async () => {
    const handler = createMusicHandler('https://music.xvyin.com', fetcher, origin, context);
    await (await handler(path('playlist/qq_main'), snapshot, 'req')).text();
    for (const mutate of [
      (value: Snapshot) => { value.releaseId = 'different-release'; },
      (value: Snapshot) => { value.playlists[0]!.id = 'different-config'; },
      (value: Snapshot) => { value.playlists[0]!.source = 'netease'; },
      (value: Snapshot) => { value.playlists[0]!.sourceId = '111111'; },
    ]) {
      const changed = structuredClone(snapshot); mutate(changed);
      await (await handler(path(`playlist/${changed.playlists[0]!.id}`), changed, 'req')).text();
    }
    expect(playlistRequests).toBe(5); expect(writes).toBe(5);
  });

  it('uses a five-minute TTL and reloads after its explicit expiry', async () => {
    const handler = createMusicHandler('https://music.xvyin.com', fetcher, origin, context);
    await (await handler(path('playlist/qq_main'), snapshot, 'req')).text();
    const stored = await context.cache.match(cacheKey());
    expect(stored!.headers.get('cache-control')).toBe('public, max-age=300');
    const expires = Number(stored!.headers.get('x-xvyin-music-expires')); await stored!.text();
    expect(expires - Date.now()).toBeGreaterThan(290000); expect(expires - Date.now()).toBeLessThanOrEqual(300000);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expires + 1);
    try { await (await handler(path('playlist/qq_main'), snapshot, 'req')).text(); }
    finally { clock.mockRestore(); }
    expect(playlistRequests).toBe(2);
  });

  it('revalidates damaged cached data and falls back to the provider', async () => {
    const handler = createMusicHandler('https://music.xvyin.com', fetcher, origin, context);
    for (const body of ['{broken', '{"wrong":"shape"}', '[{"id":{}}]']) {
      await context.cache.put(cacheKey(), new Response(body, { headers: { 'cache-control': 'public, max-age=300', 'x-xvyin-music-expires': String(Date.now() + 300000) } }));
      expect((await (await handler(path('playlist/qq_main'), snapshot, 'req')).json() as any).data[0].id).toBe('123');
    }
    expect(playlistRequests).toBe(3);
  });

  it('ignores cache outages and never caches provider errors or an oversized list', async () => {
    const broken: PublicReadCache = { ...context, cache: { match: vi.fn(async () => { throw new Error('cache unavailable'); }), put: vi.fn(async () => { throw new Error('cache unavailable'); }) } };
    const fallback = createMusicHandler('https://music.xvyin.com', fetcher, origin, broken);
    expect((await fallback(path('playlist/qq_main'), snapshot, 'req')).status).toBe(200);
    const invalid = createMusicHandler('https://music.xvyin.com', vi.fn(async () => Response.json({ invalid: true })), origin, context);
    await expect(invalid(path('playlist/qq_main'), snapshot, 'req')).rejects.toMatchObject({ code: 'MUSIC_UNAVAILABLE' }); expect(writes).toBe(0);
    const largeFetch = vi.fn<typeof fetch>(async () => Response.json([{ id: '123', title: 'a'.repeat(1024 * 1024 + 1) }]));
    const large = createMusicHandler('https://music.xvyin.com', largeFetch, origin, context);
    for (let i = 0; i < 2; i++) expect((await large(path('playlist/qq_main'), snapshot, 'req')).status).toBe(200);
    expect(largeFetch).toHaveBeenCalledTimes(2); expect(writes).toBe(0);
  });

  it('never caches signed stream destinations even while reusing the list', async () => {
    const handler = createMusicHandler('https://music.xvyin.com', fetcher, origin, context);
    const first = await handler(path('stream/qq_main/123'), snapshot, 'req');
    const second = await handler(path('stream/qq_main/123'), snapshot, 'req');
    expect(first.status).toBe(307); expect(second.status).toBe(307);
    expect(first.headers.get('location')).toContain('token=1'); expect(second.headers.get('location')).toContain('token=2');
    expect(first.headers.get('cache-control')).toBe('private, no-store'); expect(second.headers.get('cache-control')).toBe('private, no-store');
    expect(playlistRequests).toBe(1); expect(streamRequests).toBe(2); expect(writes).toBe(1);
  });

  it('leaves private preview calls entirely uncached when no context is supplied', async () => {
    const handler = createMusicHandler('https://music.xvyin.com', fetcher, origin);
    for (let i = 0; i < 2; i++) await (await handler(path('playlist/qq_main'), snapshot, 'req')).text();
    expect(playlistRequests).toBe(2); expect(matches).toBe(0); expect(writes).toBe(0);
  });
});
