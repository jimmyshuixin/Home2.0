import { z } from 'zod';
import { IdSchema } from '@xvyin/contracts';
import { assert, ApiError } from './errors';
import { readBoundedJson } from './store/google-oauth';
import type { Snapshot } from './releases';
import { qqBrowserPage } from './qq-browser';
import { cacheRead, cacheWrite, publicCacheKey, type PublicReadCache } from './public-read-cache';
const musicId = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/u);
const providerTrack = z.object({ id: z.union([z.string(), z.number()]).transform(String), songmid: z.string().optional(), title: z.string().optional(), name: z.string().optional(), author: z.union([z.string(), z.array(z.string())]).optional(), artist: z.union([z.string(), z.array(z.string())]).optional(), pic: z.string().optional(), cover: z.string().optional(), lrc: z.string().optional() });
const providerTracks = z.array(providerTrack).max(1000);
const PLAYLIST_CACHE_SECONDS = 300, PLAYLIST_CACHE_BYTES = 1024 * 1024;
type DiagnosticStage = 'provider_fetch' | 'provider_decode' | 'resolver_shape' | 'native_fetch' | 'native_decode' | 'native_result' | 'native_destination';
type DiagnosticDetails = { httpStatus?: number | null; accepted?: boolean; legacyDescriptor?: boolean; embeddedLegacyDescriptor?: boolean; nativeCalled?: boolean; schemaValid?: boolean; qqCode?: number | null; qqRequestCode?: number | null; qqItemCodes?: Array<number | null>; hasEntries?: boolean; hasPurl?: boolean };
function diagnose(requestId: string | undefined, stage: DiagnosticStage, details: DiagnosticDetails): void {
  // Fixed fields only. Never include URLs, song IDs, response bodies, error
  // messages, cookies or credentials; Cloudflare tail can correlate by UUID.
  console.info(JSON.stringify({ event: 'qq_music_resolution', requestId: requestId && /^[a-f0-9-]{36}$/u.test(requestId) ? requestId : null, stage, ...details }));
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const numericCode = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : null;
function publicMediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8000) return undefined;
  try {
    const url = new URL(value);
    const hosts = ['qq.com', 'gtimg.cn', 'qpic.cn', 'music.126.net', 'music.163.com', 'music.xvyin.com'];
    return url.protocol === 'https:' && !url.username && !url.password && hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.toString() : undefined;
  } catch { return undefined; }
}
function qqCover(value: unknown): string | undefined {
  const safe = publicMediaUrl(value); if (!safe) return undefined;
  const url = new URL(safe);
  return url.hostname === 'y.gtimg.cn' && /^\/music\/photo_new\/T002R[0-9]{2,4}x[0-9]{2,4}M000[A-Za-z0-9]{1,80}\.jpg$/u.test(url.pathname) && !url.hash ? safe : undefined;
}
async function boundedText(response: Response, maximum: number): Promise<string> {
  assert(response.body, 'MUSIC_UNAVAILABLE', 503, '音乐平台返回了空响应');
  const length = response.headers.get('content-length');
  if (length && Number(length) > maximum) { await response.body.cancel(); throw new ApiError('MUSIC_UNAVAILABLE', 503, '音乐平台响应过大'); }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0, text = '';
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > maximum) { await reader.cancel(); throw new Error('too large'); } text += decoder.decode(next.value, { stream: true }); }
    return text + decoder.decode();
  } catch { throw new ApiError('MUSIC_UNAVAILABLE', 503, '音乐平台响应无效'); }
  finally { reader.releaseLock(); }
}
// The legacy music service sometimes exposes its internal deferred resolver
// instead of JSON. Validate the descriptor, but never execute a callback or
// fetch an upstream-supplied URL. A fresh request below uses the native QQ API.
function legacyQQDescriptor(value: unknown, songmid: string): boolean {
  if (typeof value !== 'string' || value.length > 16000 || !value.startsWith('@qq_get_url_from_json@callback@callback@')) return false;
  try {
    const url = new URL(value.slice('@qq_get_url_from_json@callback@callback@'.length));
    if (url.origin !== 'https://u.y.qq.com' || url.pathname !== '/cgi-bin/musicu.fcg' || url.username || url.password || url.hash) return false;
    const payload = JSON.parse(url.searchParams.get('data') || '{}') as { req_0?: { module?: string; method?: string; param?: { songmid?: unknown } } };
    return payload.req_0?.module === 'vkey.GetVkeyServer' && payload.req_0.method === 'CgiGetVkey' && Array.isArray(payload.req_0.param?.songmid) && payload.req_0.param.songmid.length === 1 && payload.req_0.param.songmid[0] === songmid;
  } catch { return false; }
}
/** Only the site's configured published playlists can be resolved; never an arbitrary URL proxy. */
export function createMusicHandler(origin: string, fetcher: typeof fetch = globalThis.fetch.bind(globalThis), siteOrigin = 'https://test.xvyin.com', publicCache?: PublicReadCache) {
  assert(origin === 'https://music.xvyin.com', 'MUSIC_NOT_CONFIGURED', 503, '音乐来源未配置');
  async function upstream(server: string, type: string, id: string, requestId?: string): Promise<unknown> {
    const url = new URL(origin); url.search = new URLSearchParams({ server, type, id: musicId.parse(id), limit: 'all' }).toString();
    const diagnoseUrl = server === 'tencent' && type === 'url';
    let response: Response;
    try { response = await fetcher(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000), redirect: 'manual' }); }
    catch { if (diagnoseUrl) diagnose(requestId, 'provider_fetch', { httpStatus: null, accepted: false }); throw new ApiError('MUSIC_UNAVAILABLE', 503, '音乐平台暂时不可用，请稍后重试'); }
    if (diagnoseUrl) diagnose(requestId, 'provider_fetch', { httpStatus: response.status, accepted: response.ok });
    if (!response.ok) await response.body?.cancel();
    assert(response.ok, 'MUSIC_UNAVAILABLE', 503, '音乐平台暂时不可用，请稍后重试');
    let text: string;
    try { text = await boundedText(response, type === 'lrc' ? 200000 : 2 * 1024 * 1024); }
    catch (error) { if (diagnoseUrl) diagnose(requestId, 'provider_decode', { accepted: false }); throw error; }
    try { return JSON.parse(text) as unknown; }
    catch { return text; }
  }
  async function nativeQQUrl(songmid: string, requestId: string): Promise<string | undefined> {
    assert(/^[A-Za-z0-9]{1,80}$/u.test(songmid), 'MUSIC_UNAVAILABLE', 503, 'QQ 曲目标识无效');
    const guid = String(crypto.getRandomValues(new Uint32Array(1))[0]);
    const url = new URL('https://u.y.qq.com/cgi-bin/musicu.fcg');
    // Anonymous normal-quality playback. QQ decides availability; no account
    // cookies, paid-file guesses, login credentials or forged IP/region headers.
    url.search = new URLSearchParams({ format: 'json', data: JSON.stringify({
      req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param: { guid, songmid: [songmid], songtype: [0], uin: '0', loginflag: 1, platform: '20' } },
      comm: { uin: 0, format: 'json', ct: 24, cv: 0 },
    }) }).toString();
    let response: Response;
    try { response = await fetcher(url, { headers: { accept: 'application/json', referer: 'https://y.qq.com/' }, redirect: 'manual', signal: AbortSignal.timeout(15000) }); }
    catch { diagnose(requestId, 'native_fetch', { httpStatus: null, accepted: false }); throw new ApiError('MUSIC_UNAVAILABLE', 503, 'QQ 音乐暂时无法提供播放地址'); }
    diagnose(requestId, 'native_fetch', { httpStatus: response.status, accepted: response.ok });
    if (!response.ok) await response.body?.cancel();
    assert(response.ok, 'MUSIC_UNAVAILABLE', 503, 'QQ 音乐暂时无法提供播放地址');
    let payload: unknown;
    try { payload = await readBoundedJson(response, 128 * 1024); } catch { diagnose(requestId, 'native_decode', { accepted: false }); throw new ApiError('MUSIC_UNAVAILABLE', 503, 'QQ 音乐返回的播放信息无效'); }
    const parsed = z.object({ code: z.number(), req_0: z.object({ code: z.number(), data: z.object({ sip: z.array(z.string().max(2000)).max(16), midurlinfo: z.array(z.object({ songmid: z.string(), purl: z.string().max(8000), result: z.number().optional() })).max(16) }).optional() }) }).safeParse(payload);
    const top = record(payload), operation = record(top.req_0), rawData = record(operation.data), entries = Array.isArray(rawData.midurlinfo) ? rawData.midurlinfo.slice(0, 16).map(record) : [];
    diagnose(requestId, 'native_result', { schemaValid: parsed.success, qqCode: numericCode(top.code), qqRequestCode: numericCode(operation.code), qqItemCodes: entries.map(item => numericCode(item.result)), hasEntries: entries.length > 0, hasPurl: entries.some(item => typeof item.purl === 'string' && item.purl.length > 0) });
    if (!parsed.success || parsed.data.code !== 0 || parsed.data.req_0.code !== 0) return undefined;
    const data = parsed.data.req_0.data, entry = data?.midurlinfo.find(item => item.songmid === songmid && (item.result === undefined || item.result === 0) && item.purl);
    if (!data || !entry) return undefined;
    // QQ still returns HTTP sip bases. Upgrade transport on the exact returned
    // QQ host; never downgrade browser media or construct a file without purl.
    for (const base of data.sip) {
      try {
        const destination = new URL(entry.purl, base);
        if (destination.protocol === 'http:') destination.protocol = 'https:';
        const safe = publicMediaUrl(destination.toString());
        if (safe && (destination.hostname === 'qq.com' || destination.hostname.endsWith('.qq.com'))) { diagnose(requestId, 'native_destination', { accepted: true }); return safe; }
      } catch { /* Another provider-supplied base may be valid. */ }
    }
    diagnose(requestId, 'native_destination', { accepted: false }); return undefined;
  }
  async function publishedTracks(snapshot: Snapshot, playlist: Snapshot['playlists'][number]) {
    // Called only after the current snapshot confirmed this configuration is
    // published/enabled. A warm upstream list never grants publication access.
    // Preview callers omit publicCache. Playback URLs and nonce pages never
    // pass through this cache; only validated provider catalogue data does.
    const key = publicCache && publicCacheKey(publicCache, snapshot.releaseId, 'index', `music-playlist/${playlist.id}/${playlist.source}/${playlist.sourceId}`);
    const hit = key && await cacheRead(publicCache, key);
    if (hit) {
      const expires = Number(hit.headers.get('x-xvyin-music-expires')), now = Date.now();
      if (hit.status === 200 && Number.isSafeInteger(expires) && expires > now && expires <= now + PLAYLIST_CACHE_SECONDS * 1000 + 1000) {
        try {
          const parsed = providerTracks.safeParse(JSON.parse(await boundedText(hit, PLAYLIST_CACHE_BYTES)));
          if (parsed.success) return parsed.data;
        } catch { /* A damaged or oversized cache entry falls back to the provider. */ }
      } else await hit.body?.cancel().catch(() => {});
    }
    const parsed = providerTracks.safeParse(await upstream(playlist.source, 'playlist', playlist.sourceId!));
    assert(parsed.success, 'MUSIC_UNAVAILABLE', 503, '音乐平台返回了暂不兼容的歌单');
    if (publicCache && key) {
      const json = JSON.stringify(parsed.data), bytes = new TextEncoder().encode(json).byteLength;
      if (bytes <= PLAYLIST_CACHE_BYTES) await cacheWrite(publicCache, key, new Response(json, { headers: {
        'content-type': 'application/json; charset=utf-8', 'content-length': String(bytes),
        'cache-control': `public, max-age=${PLAYLIST_CACHE_SECONDS}`,
        'x-xvyin-music-expires': String(Date.now() + PLAYLIST_CACHE_SECONDS * 1000),
      } }));
    }
    return parsed.data;
  }
  return async (request: Request, snapshot: Snapshot, requestId: string): Promise<Response> => {
    assert(request.method === 'GET' || request.method === 'HEAD', 'METHOD_NOT_ALLOWED', 405, '音乐接口只接受读取');
    const match = /^\/api\/v1\/music\/(playlist|stream|lyrics|cover|browser)\/([^/]+)(?:\/([^/]+))?$/u.exec(new URL(request.url).pathname);
    assert(match, 'NOT_FOUND', 404, '音乐接口不存在');
    const mode = match[1]!, playlistId = IdSchema.parse(decodeURIComponent(match[2]!)), trackId = match[3] ? musicId.parse(decodeURIComponent(match[3])) : null;
    const playlist = snapshot.playlists.find(item => item.id === playlistId && item.enabled);
    assert(playlist, 'NOT_FOUND', 404, '公开歌单不存在');
    const json = (data: unknown) => new Response(request.method === 'HEAD' ? null : JSON.stringify({ data, meta: { requestId, schemaVersion: 1, releaseId: snapshot.releaseId } }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' } });
    if (playlist.source === 'local') {
      assert(mode === 'playlist', 'NOT_FOUND', 404, '本地音乐通过媒体库读取');
      return json(playlist.tracks.map(track => ({ ...track, url: track.assetId ? `/api/v1/media/${track.assetId}/playback` : undefined, coverUrl: track.coverAssetId ? `/api/v1/media/${track.coverAssetId}/thumb` : undefined })));
    }
    assert(playlist.sourceId, 'MUSIC_NOT_CONFIGURED', 503, '外部歌单地址尚未设置');
    const tracks = await publishedTracks(snapshot, playlist);
    if (mode === 'playlist') return json(tracks.filter(track => musicId.safeParse(track.id).success).map(track => ({ id: track.id, title: (track.title || track.name || '未命名曲目').slice(0, 240), artist: [track.author || track.artist || ''].flat().join(' / ').slice(0, 240), url: `/api/v1/music/stream/${playlist.id}/${encodeURIComponent(track.id)}`, ...(playlist.source === 'tencent' && /^[A-Za-z0-9]{1,80}$/u.test(track.songmid || track.id) ? { playback: { kind: 'qq-anonymous', songmid: track.songmid || track.id }, sourceUrl: `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(track.songmid || track.id)}` } : {}), coverUrl: playlist.source === 'tencent' && qqCover(track.pic || track.cover) ? `/api/v1/music/cover/${playlist.id}/${encodeURIComponent(track.id)}` : publicMediaUrl(track.pic || track.cover), lyrics: track.lrc?.startsWith('[') ? track.lrc.slice(0, 100000) : '', lyricsUrl: `/api/v1/music/lyrics/${playlist.id}/${encodeURIComponent(track.id)}` })));
    const track = tracks.find(item => item.id === trackId); assert(track, 'NOT_FOUND', 404, '曲目不在公开歌单中');
    if (mode === 'browser') {
      assert(playlist.source === 'tencent', 'NOT_FOUND', 404, 'QQ 播放接口不存在');
      return qqBrowserPage(request, track.songmid || track.id, siteOrigin);
    }
    if (mode === 'cover') {
      const location = playlist.source === 'tencent' ? qqCover(track.pic || track.cover) : undefined;
      assert(location, 'NOT_FOUND', 404, '曲目封面不存在');
      const cover = await fetcher(location, { headers: { accept: 'image/jpeg', referer: 'https://y.qq.com/' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      const bytes = Number(cover.headers.get('content-length')), contentType = cover.headers.get('content-type')?.split(';')[0];
      if (!cover.ok || contentType !== 'image/jpeg' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 2 * 1024 * 1024) { await cover.body?.cancel(); throw new ApiError('MUSIC_UNAVAILABLE', 503, 'QQ 音乐封面暂时不可用'); }
      if (request.method === 'HEAD') await cover.body?.cancel();
      return new Response(request.method === 'HEAD' ? null : cover.body, { headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
    }
    const resolved = await upstream(playlist.source, mode === 'lyrics' ? 'lrc' : 'url', track.songmid || track.id, requestId);
    if (mode === 'lyrics') {
      if (typeof resolved === 'string' && (resolved === '' || /^\s*\[[^\]\r\n]{1,240}\]/u.test(resolved))) return json({ lyrics: resolved });
      const parsed = z.object({ lyric: z.string().max(200000).optional(), lrc: z.string().max(200000).optional() }).safeParse(resolved); assert(parsed.success, 'MUSIC_UNAVAILABLE', 503, '歌词暂时不可用'); return json({ lyrics: parsed.data.lyric || parsed.data.lrc || '' });
    }
    const parsed = z.object({ url: z.string() }).safeParse(resolved);
    const legacyDescriptor = playlist.source === 'tencent' && legacyQQDescriptor(resolved, track.songmid || track.id);
    if (playlist.source === 'tencent') diagnose(requestId, 'resolver_shape', { schemaValid: parsed.success, legacyDescriptor, embeddedLegacyDescriptor: parsed.success && legacyQQDescriptor(parsed.data.url, track.songmid || track.id), nativeCalled: !parsed.success && legacyDescriptor });
    const location = parsed.success ? publicMediaUrl(parsed.data.url) : legacyDescriptor ? await nativeQQUrl(track.songmid || track.id, requestId) : undefined;
    assert(location, 'MUSIC_UNAVAILABLE', 503, '这首曲目暂时没有可用播放地址，请选择另一首');
    return new Response(null, { status: 307, headers: { location, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' } });
  };
}
