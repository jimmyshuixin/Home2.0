/** Parse known platform links locally; never fetch arbitrary pasted URLs. */
export function providerContentId(provider: string, input: string): string {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{1,200}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return value;
    const host = url.hostname.toLowerCase(), segments = url.pathname.split('/').filter(Boolean);
    let id: string | null | undefined;
    if (provider === 'bilibili' && ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host) && segments[0] === 'video') id = segments[1];
    if (provider === 'douyin' && ['douyin.com', 'www.douyin.com'].includes(host) && segments.length === 2 && segments[0] === 'video' && /^[1-9][0-9]{18,19}$/u.test(segments[1] || '')) id = segments[1];
    if (provider === 'youtube') {
      if (host === 'youtu.be') id = segments[0];
      if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) id = ['shorts', 'embed'].includes(segments[0] || '') ? segments[1] : url.searchParams.get('v');
    }
    if (provider === 'tencent' && host === 'y.qq.com') { const at = segments.findIndex(segment => ['songDetail', 'song'].includes(segment)); if (at >= 0) id = segments[at + 1]?.replace(/\.html$/, ''); }
    if (provider === 'netease' && ['music.163.com', 'y.music.163.com'].includes(host)) id = url.searchParams.get('id') || new URLSearchParams(url.hash.split('?')[1] || '').get('id');
    return id && /^[A-Za-z0-9_-]{1,200}$/.test(id) ? id : value;
  } catch { return value; }
}
