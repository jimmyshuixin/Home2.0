import type { ProviderRef } from '@xvyin/contracts'

export interface ProviderEmbed { provider: 'bilibili' | 'youtube'; label: string; src: string }

/** Only build official player URLs from identifiers; never accept iframe HTML or a supplied URL. */
export function providerEmbed(ref?: ProviderRef): ProviderEmbed | undefined {
  if (!ref) return undefined
  const id = ref.contentId
  if (typeof id !== 'string' || /\s/u.test(id)) return undefined
  if (ref.provider === 'bilibili') {
    const query = /^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(id) ? `bvid=${id}`
      : /^av[1-9][0-9]{0,15}$/.test(id) ? `aid=${id.slice(2)}` : undefined
    if (query) return { provider: 'bilibili', label: 'BiliBili', src: `https://player.bilibili.com/player.html?${query}&autoplay=0&poster=1&p=1` }
  }
  if (ref.provider === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(id)) {
    return { provider: 'youtube', label: 'YouTube', src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=0&playsinline=1&rel=0` }
  }
  return undefined
}
