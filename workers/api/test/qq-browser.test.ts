import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { PlaylistDraftSchema } from '@xvyin/contracts';
import { createMusicHandler } from '../src/music';
import { qqBrowserPage } from '../src/qq-browser';
import { emptySnapshot } from '../src/releases';
import { readQqPlaybackMessage, safeQqPlaybackUrl } from '../../../apps/web/lib/qq-browser-resolver';

const nonce = randomUUID(), mid = '003x62qC4OxNPT';
const request = () => new Request(`https://test.xvyin.com/api/v1/music/browser/qq/song?nonce=${nonce}`);
async function isolatedRuntime() {
  const response = qqBrowserPage(request(), mid, 'https://test.xvyin.com');
  const html = await response.text(), postMessage = vi.fn(), append = vi.fn();
  const scope: any = { URL, parent: { postMessage }, document: { createElement: () => ({}), head: { append } }, setTimeout: vi.fn() };
  scope.window = scope;
  // Only our generated, first-party script is executed. The remote script tag
  // is captured by a fake DOM, never fetched or evaluated in tests.
  runInNewContext(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)![1]!, scope, { timeout: 1000 });
  return { response, scope, postMessage, append };
}
function payload(purl = 'C400fixture.m4a?vkey=fixture', result = 0, songmid = mid) {
  return { code: 0, req_0: { code: 0, data: { sip: ['http://aqqmusic.tc.qq.com/'], midurlinfo: [{ songmid, purl, result }] } } };
}
describe('isolated QQ browser playback', () => {
  it('allows only the fixed QQ script and keeps site data in a separate origin', async () => {
    const { response, append } = await isolatedRuntime();
    const csp = response.headers.get('content-security-policy')!;
    expect(csp).toContain('sandbox allow-scripts;'); expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("connect-src 'none'"); expect(csp).toContain('frame-ancestors https://test.xvyin.com');
    expect(csp).not.toContain('unsafe-inline');
    expect(response.headers.get('cross-origin-embedder-policy')).toBe('credentialless');
    const script = append.mock.calls[0]![0], url = new URL(script.src);
    expect(url.origin + url.pathname).toBe('https://u.y.qq.com/cgi-bin/musicu.fcg');
    expect(url.searchParams.get('callback')).toBe('xvyinQQCallback');
    expect(url.searchParams.get('format')).toBe('jsonp');
    expect(JSON.parse(url.searchParams.get('data')!).req_0.param.uin).toBe('0');
    expect(script.crossOrigin).toBeUndefined();
  });
  it('returns only a validated media URL to the exact parent origin once', async () => {
    const { scope, postMessage } = await isolatedRuntime();
    scope.xvyinQQCallback(payload()); scope.xvyinQQCallback(payload());
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]).toEqual([{ type: 'xvyin:qq-result', nonce, songmid: mid, ok: true, url: 'https://aqqmusic.tc.qq.com/C400fixture.m4a?vkey=fixture' }, 'https://test.xvyin.com']);
  });
  it.each([payload('', 104003), payload('https://evil.invalid/track.m4a'), payload('https://user:secret@qq.com/track'), payload('x', 0, 'other')])('preserves provider refusal and rejects injected media targets', async value => {
    const { scope, postMessage } = await isolatedRuntime(); scope.xvyinQQCallback(value);
    expect(postMessage.mock.calls[0]![0]).toMatchObject({ ok: false, code: 'QQ_UNAVAILABLE' });
  });
  it('rejects arbitrary parent origins and invalid nonces before rendering code', () => {
    expect(() => qqBrowserPage(request(), mid, 'https://evil.invalid')).toThrow();
    expect(() => qqBrowserPage(new Request('https://test.xvyin.com/?nonce=%3Cscript%3E'), mid, 'https://test.xvyin.com')).toThrow();
    expect(() => qqBrowserPage(request(), '</script>', 'https://test.xvyin.com')).toThrow();
  });
  it('checks published membership before serving any resolver document', async () => {
    const snapshot = emptySnapshot('fixture');
    snapshot.playlists.push({ ...PlaylistDraftSchema.parse({ name: 'Fixture', source: 'tencent', sourceId: '9206816111' }), id: 'qq', revisionId: 'r', publishedAt: '2026-09-12T00:00:00Z' });
    const fetcher = vi.fn().mockImplementation(async () => Response.json([{ id: 'member', songmid: mid }]));
    const handler = createMusicHandler('https://music.xvyin.com', fetcher);
    await expect(handler(request(), snapshot, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const response = await handler(new Request(`https://test.xvyin.com/api/v1/music/browser/qq/member?nonce=${nonce}`), snapshot, randomUUID());
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toMatch(/^text\/html/u);
    expect(fetcher).toHaveBeenCalledTimes(2); // Playlist reads only; QQ executes in the visitor browser.
  });
  it('validates parent messages independently and rejects host confusion', () => {
    const valid = { type: 'xvyin:qq-result', nonce, songmid: mid, ok: true, url: 'https://aqqmusic.tc.qq.com/fixture.m4a' };
    expect(readQqPlaybackMessage(valid, nonce, mid)).toEqual({ ok: true, url: valid.url });
    expect(readQqPlaybackMessage(valid, randomUUID(), mid)).toBeNull();
    expect(readQqPlaybackMessage(valid, nonce, 'different')).toBeNull();
    for (const url of ['http://qq.com/audio', 'https://qq.com.evil.invalid/audio', 'https://evil.invalid/audio', 'https://user:pass@qq.com/audio', 'https://qq.com:444/audio', '//qq.com/audio']) expect(safeQqPlaybackUrl(url)).toBeNull();
  });
});
