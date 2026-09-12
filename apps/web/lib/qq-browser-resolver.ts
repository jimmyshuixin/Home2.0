export class QqPlaybackError extends Error {
  constructor(readonly code: 'QQ_BROWSER_UNSUPPORTED' | 'QQ_UNAVAILABLE' | 'QQ_TIMEOUT', message: string) { super(message); this.name = 'QqPlaybackError' }
}
export interface QqPlaybackInput { songmid: string; playlistId: string; trackId: string }
export function safeQqPlaybackUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8000 || /[\u0000-\u0020\\]/u.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && (url.hostname === 'qq.com' || url.hostname.endsWith('.qq.com')) ? url.href : null
  } catch { return null }
}
export function readQqPlaybackMessage(value: unknown, nonce: string, songmid: string): { ok: true; url: string } | { ok: false } | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  if (message.type !== 'xvyin:qq-result' || message.nonce !== nonce || message.songmid !== songmid) return null
  if (message.ok !== true) return { ok: false }
  const url = safeQqPlaybackUrl(message.url)
  return url ? { ok: true, url } : { ok: false }
}
/** No provider code runs in the site window. Temporary URLs live in memory only. */
export function resolveQqBrowser(input: QqPlaybackInput, signal?: AbortSignal): Promise<string> {
  if (typeof window === 'undefined') return Promise.reject(new QqPlaybackError('QQ_BROWSER_UNSUPPORTED', '请在浏览器中点击播放 QQ 音乐。'))
  if (!/^[A-Za-z0-9]{1,80}$/u.test(input.songmid) || !/^[A-Za-z0-9_-]{1,160}$/u.test(input.playlistId) || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(input.trackId)) return Promise.reject(new QqPlaybackError('QQ_UNAVAILABLE', 'QQ 曲目信息无效。'))
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Playback cancelled', 'AbortError')); return }
    const nonce = crypto.randomUUID(), iframe = document.createElement('iframe')
    iframe.hidden = true; iframe.title = 'QQ 音乐安全播放解析'; iframe.setAttribute('sandbox', 'allow-scripts'); iframe.referrerPolicy = 'no-referrer'
    // Do not make the initial same-origin document request credentialless:
    // administrator preview authorization must reach our own endpoint. Its
    // COEP response also strips credentials from the outgoing QQ script on
    // supporting browsers. The opaque sandbox isolates site data on all
    // supported browsers, including those without COEP credentialless.
    iframe.src = `/api/v1/music/browser/${encodeURIComponent(input.playlistId)}/${encodeURIComponent(input.trackId)}?nonce=${nonce}`
    let settled = false
    const finish = (error?: Error, url?: string) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); window.removeEventListener('message', message); iframe.remove(); error ? reject(error) : resolve(url!) }
    const aborted = () => finish(new DOMException('Playback cancelled', 'AbortError'))
    const message = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || event.origin !== 'null') return
      const result = readQqPlaybackMessage(event.data, nonce, input.songmid)
      if (result) result.ok ? finish(undefined, result.url) : finish(new QqPlaybackError('QQ_UNAVAILABLE', 'QQ 音乐暂未提供这首歌的播放地址，请换一首或前往原平台。'))
    }
    const timer = setTimeout(() => finish(new QqPlaybackError('QQ_TIMEOUT', 'QQ 音乐响应超时，请稍后重试。')), 20000)
    window.addEventListener('message', message); signal?.addEventListener('abort', aborted, { once: true }); document.body.appendChild(iframe)
  })
}
