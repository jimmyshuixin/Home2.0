import { z } from 'zod';
import { IdSchema } from '@xvyin/contracts';
import { assert } from './errors';
import { readBoundedJson } from './store/google-oauth';
import type { Snapshot } from './releases';
const musicId = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/u);
const providerTrack = z.object({ id: z.union([z.string(), z.number()]).transform(String), songmid: z.string().optional(), title: z.string().optional(), name: z.string().optional(), author: z.union([z.string(), z.array(z.string())]).optional(), artist: z.union([z.string(), z.array(z.string())]).optional(), pic: z.string().optional(), cover: z.string().optional(), lrc: z.string().optional() });
function publicMediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8000) return undefined;
  try {
    const url = new URL(value);
    const hosts = ['qq.com', 'gtimg.cn', 'qpic.cn', 'music.126.net', 'music.163.com', 'music.xvyin.com'];
    return url.protocol === 'https:' && !url.username && !url.password && hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.toString() : undefined;
  } catch { return undefined; }
}
/** Only the site's configured published playlists can be resolved; never an arbitrary URL proxy. */
export function createMusicHandler(origin: string, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
  assert(origin === 'https://music.xvyin.com', 'MUSIC_NOT_CONFIGURED', 503, '音乐来源未配置');
  async function upstream(server: string, type: string, id: string): Promise<unknown> {
    const url = new URL(origin); url.search = new URLSearchParams({ server, type, id: musicId.parse(id), limit: 'all' }).toString();
    const response = await fetcher(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000), redirect: 'error' });
    assert(response.ok, 'MUSIC_UNAVAILABLE', 503, '音乐平台暂时不可用，可选择站内歌单');
    return readBoundedJson(response, 2 * 1024 * 1024);
  }
  return async (request: Request, snapshot: Snapshot, requestId: string): Promise<Response> => {
    assert(request.method === 'GET' || request.method === 'HEAD', 'METHOD_NOT_ALLOWED', 405, '音乐接口只接受读取');
    const match = /^\/api\/v1\/music\/(playlist|stream|lyrics)\/([^/]+)(?:\/([^/]+))?$/u.exec(new URL(request.url).pathname);
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
    const parsedTracks = z.array(providerTrack).max(1000).safeParse(await upstream(playlist.source, 'playlist', playlist.sourceId));
    assert(parsedTracks.success, 'MUSIC_UNAVAILABLE', 503, '音乐平台返回了暂不兼容的歌单'); const tracks = parsedTracks.data;
    if (mode === 'playlist') return json(tracks.filter(track => musicId.safeParse(track.id).success).map(track => ({ id: track.id, title: (track.title || track.name || '未命名曲目').slice(0, 240), artist: [track.author || track.artist || ''].flat().join(' / ').slice(0, 240), url: `/api/v1/music/stream/${playlist.id}/${encodeURIComponent(track.id)}`, coverUrl: publicMediaUrl(track.pic || track.cover), lyrics: track.lrc?.startsWith('[') ? track.lrc.slice(0, 100000) : '', lyricsUrl: `/api/v1/music/lyrics/${playlist.id}/${encodeURIComponent(track.id)}` })));
    const track = tracks.find(item => item.id === trackId); assert(track, 'NOT_FOUND', 404, '曲目不在公开歌单中');
    const resolved = await upstream(playlist.source, mode === 'lyrics' ? 'lrc' : 'url', track.songmid || track.id);
    if (mode === 'lyrics') { const parsed = z.object({ lyric: z.string().max(200000).optional(), lrc: z.string().max(200000).optional() }).safeParse(resolved); assert(parsed.success, 'MUSIC_UNAVAILABLE', 503, '歌词暂时不可用'); return json({ lyrics: parsed.data.lyric || parsed.data.lrc || '' }); }
    const parsed = z.object({ url: z.string() }).safeParse(resolved), location = parsed.success ? publicMediaUrl(parsed.data.url) : undefined;
    assert(location, 'MUSIC_UNAVAILABLE', 503, '这首曲目暂时没有可用播放地址，请选择另一首');
    return new Response(null, { status: 307, headers: { location, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' } });
  };
}
