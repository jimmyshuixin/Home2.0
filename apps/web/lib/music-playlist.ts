import type { Playlist } from './models'

type PlaylistChoice = Pick<Playlist, 'id' | 'source' | 'isDefault'>

/** Keep an explicit visitor choice; otherwise prefer QQ without changing the published order. */
export function preferredMusicPlaylist(playlists: readonly PlaylistChoice[], chosenId?: string): string {
  return playlists.find(playlist => playlist.id === chosenId)?.id
    || playlists.find(playlist => playlist.source === 'tencent' && playlist.isDefault)?.id
    || playlists.find(playlist => playlist.source === 'tencent')?.id
    || playlists.find(playlist => playlist.isDefault)?.id
    || playlists[0]?.id || ''
}

export const musicModes = ['sequential', 'shuffle', 'repeat-one'] as const
export type MusicMode = typeof musicModes[number]
export const musicModeLabels: Record<MusicMode, string> = { sequential: '顺序播放', shuffle: '随机播放', 'repeat-one': '单曲循环' }

/** A shuffle step samples every other track equally; one-track playlists remain playable. */
export function nextMusicIndex(index: number, count: number, mode: MusicMode, random = Math.random): number | null {
  if (count < 1) return null
  if (index < 0 || index >= count) return 0
  if (count === 1 || mode === 'repeat-one') return index
  if (mode === 'shuffle') {
    const candidate = Math.floor(random() * (count - 1))
    return candidate >= index ? candidate + 1 : candidate
  }
  return (index + 1) % count
}
