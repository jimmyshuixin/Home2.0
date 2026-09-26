import { describe, expect, it } from 'vitest'
import { providerEmbed } from '../lib/provider-embed'

describe('official video player URL boundaries', () => {
  it.each([
    ['bilibili', 'BV1B7411m7LV', 'https://player.bilibili.com', '/player.html', 'bvid', 'BV1B7411m7LV'],
    ['bilibili', 'av170001', 'https://player.bilibili.com', '/player.html', 'aid', '170001'],
    ['youtube', 'dQw4w9WgXcQ', 'https://www.youtube-nocookie.com', '/embed/dQw4w9WgXcQ', undefined, undefined],
  ] as const)('builds a fixed HTTPS player for %s %s with autoplay disabled', (provider, contentId, origin, path, idKey, id) => {
    const result = providerEmbed({ provider, contentId })!
    const url = new URL(result.src)
    expect(result.provider).toBe(provider)
    expect(url.origin).toBe(origin); expect(url.pathname).toBe(path)
    expect(url.searchParams.get('autoplay')).toBe('0')
    expect(url.username).toBe(''); expect(url.password).toBe(''); expect(url.hash).toBe('')
    if (idKey) {
      expect(url.searchParams.get(idKey)).toBe(id)
      expect(url.searchParams.get('poster')).toBe('1')
      expect(url.searchParams.get('p')).toBe('1')
    } else expect(url.searchParams.get('playsinline')).toBe('1')
  })

  it.each([
    '', 'https://evil.invalid/video', '//player.bilibili.com/player.html', 'javascript:alert(1)',
    '<iframe src=x>', 'BV1B7411m7LV&autoplay=1', 'BV1B7411m7LV?bvid=evil', 'BV1B7411m7LV/../',
    'BV1B7411m7LV\n', ' BV1B7411m7LV', 'bv1B7411m7LV', 'BV0000000000',
    'BV1B7411m7L', 'BV1B7411m7LVx', 'av0', 'av-1', 'av1.2', 'av99999999999999999',
    'av1&p=2', 'av1%26autoplay=1',
  ])('does not embed malformed BiliBili input %j', contentId => {
    expect(providerEmbed({ provider: 'bilibili', contentId })).toBeUndefined()
  })

  it.each(['', 'abcdefghij', 'abcdefghijkl', 'dQw4w9WgXcQ?autoplay=1', 'dQw4w9WgXcQ\n', 'dQw4w9WgXc/', 'https://youtu.be/dQw4w9WgXcQ'])('does not embed malformed YouTube input %j', contentId => {
    expect(providerEmbed({ provider: 'youtube', contentId })).toBeUndefined()
  })

  it('keeps unsupported or absent providers on their existing fallback', () => {
    expect(providerEmbed()).toBeUndefined()
    expect(providerEmbed({ provider: 'netease', contentId: '12345678901' })).toBeUndefined()
    expect(providerEmbed({ provider: 'tencent', contentId: 'BV1B7411m7LV' })).toBeUndefined()
    expect(providerEmbed({ provider: 'youtube', contentId: 'BV1B7411m7LV' })).toBeUndefined()
  })
})
