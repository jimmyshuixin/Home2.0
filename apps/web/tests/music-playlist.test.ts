import { describe, expect, it } from 'vitest'
import { preferredMusicPlaylist } from '../lib/music-playlist'

const local = { id: 'local', source: 'local' as const, isDefault: true }
const qq = { id: 'qq', source: 'tencent' as const, isDefault: false }
const otherQq = { id: 'other-qq', source: 'tencent' as const, isDefault: true }
const netease = { id: 'netease', source: 'netease' as const, isDefault: false }

describe('initial QQ playlist preference and visitor selection', () => {
  it('prefers QQ on entry even when a local playlist is the published default', () => {
    expect(preferredMusicPlaylist([local, qq])).toBe('qq')
  })

  it('uses the default QQ playlist when more than one QQ playlist is available', () => {
    expect(preferredMusicPlaylist([local, qq, otherQq])).toBe('other-qq')
  })

  it('keeps the published order among QQ playlists with the same preference', () => {
    const playlists = [local, qq, { ...otherQq, isDefault: false }]
    expect(preferredMusicPlaylist(playlists)).toBe('qq')
    expect(playlists.map(playlist => playlist.id)).toEqual(['local', 'qq', 'other-qq'])
  })

  it('allows the first API refresh to select QQ after a snapshot without QQ', () => {
    expect(preferredMusicPlaylist([local])).toBe('local')
    expect(preferredMusicPlaylist([local, qq])).toBe('qq')
  })

  it.each([local, qq, netease])('preserves an explicit $source choice on subsequent refreshes', chosen => {
    expect(preferredMusicPlaylist([local, qq, otherQq, netease], chosen.id)).toBe(chosen.id)
  })

  it('falls back to QQ when the visitor selection has been removed', () => {
    expect(preferredMusicPlaylist([local, qq], 'removed')).toBe('qq')
  })

  it('retains the published default or first playlist fallback when no QQ exists', () => {
    expect(preferredMusicPlaylist([netease, local])).toBe('local')
    expect(preferredMusicPlaylist([netease, { ...local, isDefault: false }])).toBe('netease')
    expect(preferredMusicPlaylist([])).toBe('')
  })
})
