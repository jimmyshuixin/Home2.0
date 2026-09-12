import { describe, expect, it, vi } from 'vitest';
import { PlaylistDraftSchema } from '@xvyin/contracts';
import { createMusicHandler } from '../src/music';
import { emptySnapshot } from '../src/releases';
function snapshot() { const value = emptySnapshot('release_test'); value.playlists.push({ ...PlaylistDraftSchema.parse({ name: 'Original QQ playlist', source: 'tencent', sourceId: '9206816111', enabled: true, isDefault: true }), id: 'qq_main', revisionId: 'revision_test', publishedAt: '2026-09-12T00:00:00.000Z' }); return value; }
const path = (suffix: string, method = 'GET') => new Request(`https://test.xvyin.com/api/v1/music/${suffix}`, { method });
function descriptor(mid = 'mid1', origin = 'https://u.y.qq.com') {
  return '@qq_get_url_from_json@callback@callback@' + origin + '/cgi-bin/musicu.fcg?' + new URLSearchParams({ data: JSON.stringify({ req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param: { songmid: [mid] } } }) });
}
const nativePayload = (purl = 'C400mid1.m4a?vkey=fixture', result = 0) => ({ code: 0, req_0: { code: 0, data: { sip: ['http://aqqmusic.tc.qq.com/'], midurlinfo: [{ songmid: 'mid1', purl, result }] } } });
describe('published playlist music boundary', () => {
  it('rejects upstream redirects without requesting their target', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://untrusted.invalid/playlist' } }));
    await expect(createMusicHandler('https://music.xvyin.com', fetcher)(path('playlist/qq_main'), snapshot(), 'req')).rejects.toMatchObject({ code: 'MUSIC_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });
  it('keeps local playback same-origin and never calls the provider', async () => { const data = snapshot(); data.playlists[0] = { ...PlaylistDraftSchema.parse({ name: 'Local', source: 'local', tracks: [{ id: 'song_1', title: 'Fixture', artist: '', assetId: 'audio_1', coverAssetId: 'cover_1' }] }), id: 'qq_main', revisionId: 'r', publishedAt: '2026-09-12T00:00:00.000Z' }; const fetcher = vi.fn(); const result = await createMusicHandler('https://music.xvyin.com', fetcher)(path('playlist/qq_main'), data, 'req'); expect((await result.json() as any).data[0].url).toBe('/api/v1/media/audio_1/playback'); expect(fetcher).not.toHaveBeenCalled(); });
  it('does not query arbitrary or disabled playlists', async () => { const fetcher = vi.fn(); const handler = createMusicHandler('https://music.xvyin.com', fetcher); await expect(handler(path('playlist/other'), snapshot(), 'req')).rejects.toMatchObject({ status: 404 }); const data = snapshot(); data.playlists[0]!.enabled = false; await expect(handler(path('playlist/qq_main'), data, 'req')).rejects.toMatchObject({ status: 404 }); expect(fetcher).not.toHaveBeenCalled(); });
  it('normalizes the verified live provider shape and hides untrusted artwork', async () => { const fetcher = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => Response.json([{ id: 123, songmid: 'mid1', title: 'Fixture', author: ['A', 'B'], pic: 'https://attacker.invalid/tracking', lrc: 'https://attacker.invalid/lyrics' }])); const response = await createMusicHandler('https://music.xvyin.com', fetcher)(path('playlist/qq_main'), snapshot(), 'request1'); const body = await response.json() as any; expect(body.data).toEqual([{ id: '123', title: 'Fixture', artist: 'A / B', url: '/api/v1/music/stream/qq_main/123', lyrics: '', lyricsUrl: '/api/v1/music/lyrics/qq_main/123' }]); expect(String(fetcher.mock.calls[0]![0])).toContain('id=9206816111'); });
  it('only resolves a published member and redirects to an approved HTTPS media host', async () => { const fetcher = vi.fn().mockResolvedValueOnce(Response.json([{ id: '123', songmid: 'mid1', name: 'Fixture' }])).mockResolvedValueOnce(Response.json({ url: 'https://isure.stream.qqmusic.qq.com/fixture.m4a' })); const response = await createMusicHandler('https://music.xvyin.com', fetcher)(path('stream/qq_main/123'), snapshot(), 'req'); expect(response.status).toBe(307); expect(response.headers.get('location')).toContain('qqmusic.qq.com'); expect(String(fetcher.mock.calls[1]![0])).toContain('id=mid1'); });
  it('rejects provider credentials, lookalike hosts and non-HTTPS destinations', async () => { for (const url of ['http://qq.com/a', 'https://qq.com.attacker.invalid/a', 'https://user:secret@qq.com/a', 'javascript:alert(1)']) { const fetcher = vi.fn().mockResolvedValueOnce(Response.json([{ id: '123' }])).mockResolvedValueOnce(Response.json({ url })); await expect(createMusicHandler('https://music.xvyin.com', fetcher)(path('stream/qq_main/123'), snapshot(), 'req')).rejects.toMatchObject({ status: 503 }); } });
  it('reports provider schema errors as availability failures and returns no body on HEAD', async () => { await expect(createMusicHandler('https://music.xvyin.com', vi.fn(async () => Response.json({ invalid: true })))(path('playlist/qq_main'), snapshot(), 'req')).rejects.toMatchObject({ status: 503 }); const response = await createMusicHandler('https://music.xvyin.com', vi.fn(async () => Response.json([])))(path('playlist/qq_main', 'HEAD'), snapshot(), 'req'); expect(await response.text()).toBe(''); });
  it('resolves the real legacy QQ descriptor through an anonymous fixed native endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([{ id: '123', songmid: 'mid1' }])).mockResolvedValueOnce(new Response(descriptor())).mockResolvedValueOnce(Response.json(nativePayload()));
    const response = await createMusicHandler('https://music.xvyin.com', fetcher)(path('stream/qq_main/123'), snapshot(), 'req');
    expect(response.status).toBe(307); expect(response.headers.get('location')).toBe('https://aqqmusic.tc.qq.com/C400mid1.m4a?vkey=fixture');
    const [input, init] = fetcher.mock.calls[2]!, url = new URL(String(input)), payload = JSON.parse(url.searchParams.get('data')!);
    expect(url.origin + url.pathname).toBe('https://u.y.qq.com/cgi-bin/musicu.fcg');
    expect(payload.req_0).toMatchObject({ module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param: { songmid: ['mid1'], uin: '0' } });
    expect(payload.req_0.param.filename).toBeUndefined();
    expect(new Headers(init?.headers).has('cookie')).toBe(false); expect(new Headers(init?.headers).has('x-forwarded-for')).toBe(false); expect(new Headers(init?.headers).has('x-real-ip')).toBe(false); expect(init?.redirect).toBe('manual');
  });
  it('never follows a malformed, foreign-host or mismatched-song legacy instruction', async () => {
    for (const value of [descriptor('otherSong'), descriptor('mid1', 'https://u.y.qq.com.attacker.invalid'), descriptor('mid1', 'https://user:password@u.y.qq.com'), '@qq_get_url_from_json@callback@callback@javascript:alert(1)', '<script>alert(1)</script>']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([{ id: '123', songmid: 'mid1' }])).mockResolvedValueOnce(new Response(value));
      await expect(createMusicHandler('https://music.xvyin.com', fetcher)(path('stream/qq_main/123'), snapshot(), 'req')).rejects.toMatchObject({ code: 'MUSIC_UNAVAILABLE' }); expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
  it('respects QQ unavailable/paid/region responses and rejects unsafe or wrong-song native media', async () => {
    for (const value of [nativePayload('', -1), nativePayload('C400mid1.m4a', 104003), nativePayload('https://qq.com.attacker.invalid/media'), nativePayload('https://user:secret@qq.com/media'), { code: 0, req_0: { code: 104003 } }, { code: 0, req_0: { code: 0, data: { sip: ['https://qq.com/'], midurlinfo: [{ songmid: 'otherSong', purl: 'file.m4a' }] } } }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([{ id: '123', songmid: 'mid1' }])).mockResolvedValueOnce(new Response(descriptor())).mockResolvedValueOnce(Response.json(value));
      await expect(createMusicHandler('https://music.xvyin.com', fetcher)(path('stream/qq_main/123'), snapshot(), 'req')).rejects.toMatchObject({ code: 'MUSIC_UNAVAILABLE' }); expect(fetcher).toHaveBeenCalledTimes(3);
    }
  });
  it('normalizes actual text/plain LRC and rejects HTML payloads', async () => {
    for (const lyric of ['[ti:Fixture]\n[00:01.00]First line', '']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([{ id: '123' }])).mockResolvedValueOnce(new Response(lyric, { headers: { 'content-type': 'text/plain' } }));
      const response = await createMusicHandler('https://music.xvyin.com', fetcher)(path('lyrics/qq_main/123'), snapshot(), 'req'); expect(await response.json()).toMatchObject({ data: { lyrics: lyric } });
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([{ id: '123' }])).mockResolvedValueOnce(new Response('<html>upstream failure</html>'));
    await expect(createMusicHandler('https://music.xvyin.com', fetcher)(path('lyrics/qq_main/123'), snapshot(), 'req')).rejects.toMatchObject({ code: 'MUSIC_UNAVAILABLE' });
  });
  it('serves allowlisted QQ cover artwork through the same origin with strict image metadata', async () => {
    const tracks = [{ id: '123', pic: 'https://y.gtimg.cn/music/photo_new/T002R300x300M000albumMid.jpg' }];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(tracks)).mockResolvedValueOnce(Response.json(tracks)).mockResolvedValueOnce(new Response(new Uint8Array([255, 216, 255, 217]), { headers: { 'content-type': 'image/jpeg', 'content-length': '4' } }));
    const handler = createMusicHandler('https://music.xvyin.com', fetcher);
    const playlist = await handler(path('playlist/qq_main'), snapshot(), 'req'); expect(await playlist.json()).toMatchObject({ data: [{ coverUrl: '/api/v1/music/cover/qq_main/123' }] });
    const cover = await handler(path('cover/qq_main/123'), snapshot(), 'req'); expect(cover.status).toBe(200); expect(cover.headers.get('content-type')).toBe('image/jpeg'); expect(new Uint8Array(await cover.arrayBuffer())).toEqual(new Uint8Array([255, 216, 255, 217]));
    expect(String(fetcher.mock.calls[2]![0])).toBe(tracks[0]!.pic);
    const invalid = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(tracks)).mockResolvedValueOnce(new Response('<html>', { headers: { 'content-type': 'text/html', 'content-length': '6' } }));
    await expect(createMusicHandler('https://music.xvyin.com', invalid)(path('cover/qq_main/123'), snapshot(), 'req')).rejects.toMatchObject({ code: 'MUSIC_UNAVAILABLE' });
  });
  it('logs only bounded stages and numeric QQ diagnostics without URLs, bodies or credentials', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {}), secret = 'DO_NOT_LOG_PROVIDER_SECRET';
    try {
      const payload = { code: 0, req_0: { code: 104003, message: secret, data: { sip: [`https://qq.com/?token=${secret}`], midurlinfo: [{ songmid: 'mid1', result: 104003, purl: `media.m4a?vkey=${secret}` }] } } };
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([{ id: '123', songmid: 'mid1' }])).mockResolvedValueOnce(new Response(descriptor())).mockResolvedValueOnce(Response.json(payload));
      await expect(createMusicHandler('https://music.xvyin.com', fetcher)(path('stream/qq_main/123'), snapshot(), secret)).rejects.toMatchObject({ code: 'MUSIC_UNAVAILABLE' });
      const logs = log.mock.calls.map(call => JSON.parse(String(call[0])));
      expect(logs.find(item => item.stage === 'resolver_shape')).toMatchObject({ schemaValid: false, legacyDescriptor: true, embeddedLegacyDescriptor: false, nativeCalled: true });
      expect(logs.find(item => item.stage === 'native_result')).toMatchObject({ qqCode: 0, qqRequestCode: 104003, qqItemCodes: [104003], hasEntries: true, hasPurl: true });
      expect(JSON.stringify(logs)).not.toContain(secret); expect(JSON.stringify(logs)).not.toContain('https:'); expect(JSON.stringify(logs)).not.toContain('songmid');
      expect(logs.every(item => item.requestId === null)).toBe(true);
      const allowed = new Set(['event', 'requestId', 'stage', 'httpStatus', 'accepted', 'legacyDescriptor', 'embeddedLegacyDescriptor', 'nativeCalled', 'schemaValid', 'qqCode', 'qqRequestCode', 'qqItemCodes', 'hasEntries', 'hasPurl']);
      expect(logs.every(item => Object.keys(item).every(key => allowed.has(key)))).toBe(true);
    } finally { log.mockRestore(); }
  });
  it('distinguishes a JSON-wrapped legacy descriptor before changing resolver behavior', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([{ id: '123', songmid: 'mid1' }])).mockResolvedValueOnce(Response.json({ url: descriptor() }));
      await expect(createMusicHandler('https://music.xvyin.com', fetcher)(path('stream/qq_main/123'), snapshot(), 'req')).rejects.toMatchObject({ code: 'MUSIC_UNAVAILABLE' });
      expect(log.mock.calls.map(call => JSON.parse(String(call[0]))).find(item => item.stage === 'resolver_shape')).toMatchObject({ schemaValid: true, legacyDescriptor: false, embeddedLegacyDescriptor: true, nativeCalled: false });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); }
  });
});
