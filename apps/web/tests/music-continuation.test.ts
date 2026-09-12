import { describe, expect, it, vi } from 'vitest'
import { MusicPlaybackController, type MusicSelection, type PlaybackAudio } from '../lib/music-playback'
import { nextMusicIndex, type MusicMode } from '../lib/music-playlist'

class AudioFixture extends EventTarget implements PlaybackAudio {
  src = ''; currentSrc = ''; paused = true; ended = false; currentTime = 0; duration = 180
  error: { code: number } | null = null
  load = vi.fn(() => { this.currentSrc = this.src; this.currentTime = 0; this.ended = false; this.dispatchEvent(new Event('loadedmetadata')) })
  pause = vi.fn(() => { this.paused = true; this.dispatchEvent(new Event('pause')) })
  play = vi.fn(async () => { this.paused = false; this.ended = false; this.dispatchEvent(new Event('playing')) })
  removeAttribute(name: string) { if (name === 'src') this.src = '' }
  finish() { this.currentTime = this.duration; this.ended = true; this.paused = true; this.dispatchEvent(new Event('ended')) }
}
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
const localTracks: MusicSelection[] = ['a', 'b', 'c'].map(id => ({ key: id, source: `/api/v1/media/${id}/playback` }))

function player(initialMode: MusicMode = 'sequential', tracks = localTracks, random = () => .99) {
  let index = 0, mode = initialMode, focus: ((audio: PlaybackAudio) => void) | undefined
  const audio = new AudioFixture()
  const nextSelection = vi.fn(() => {
    const next = nextMusicIndex(index, tracks.length, mode, random)
    if (next === null) return null
    index = next
    return tracks[index] || null
  })
  const controller = new MusicPlaybackController({ resolveQq: vi.fn(), nextSelection, subscribeFocus: listener => { focus = listener; return () => { focus = undefined } } })
  controller.attach(audio)
  return { audio, controller, nextSelection, select: () => controller.select(tracks[index] || null, true),
    mode: (value: MusicMode) => { mode = value }, otherMedia: () => focus?.(new AudioFixture()) }
}

describe('natural song completion and playback modes', () => {
  it('plays each next track in order and wraps from the last track to the first', async () => {
    const p = player(); await p.select()
    for (const key of ['b', 'c', 'a']) {
      p.audio.finish(); await settle()
      expect(p.controller.state.key).toBe(key); expect(p.controller.state.playing).toBe(true)
    }
    expect(p.audio.play).toHaveBeenCalledTimes(4); p.controller.dispose()
  })

  it('randomly advances without repeating the current track in a multi-track playlist', async () => {
    const p = player('shuffle'); await p.select()
    p.audio.finish(); await settle(); expect(p.controller.state.key).toBe('c')
    p.audio.finish(); await settle(); expect(p.controller.state.key).toBe('b')
    p.controller.dispose()
  })

  it('restarts one-track or repeat-one playback from zero using the existing source', async () => {
    for (const p of [player('repeat-one'), player('sequential', localTracks.slice(0, 1))]) {
      await p.select(); const loads = p.audio.load.mock.calls.length
      p.audio.finish(); await settle()
      expect(p.controller.state.key).toBe('a'); expect(p.audio.currentTime).toBe(0)
      expect(p.controller.state.playing).toBe(true); expect(p.audio.load).toHaveBeenCalledTimes(loads)
      p.controller.dispose()
    }
  })

  it('changes the following mode without interrupting playback or starting paused music', async () => {
    const p = player(); await p.select(); p.mode('shuffle')
    expect(p.audio.play).toHaveBeenCalledTimes(1); expect(p.controller.state.key).toBe('a')
    p.audio.finish(); await settle(); expect(p.controller.state.key).toBe('c')
    p.controller.pause(); p.mode('repeat-one'); await settle()
    expect(p.audio.play).toHaveBeenCalledTimes(2); expect(p.controller.state.desiredPlay).toBe(false)
    p.controller.dispose()
  })

  it('does not advance from an empty playlist or a duplicate ended event', async () => {
    const empty = player('sequential', []); await empty.select(); empty.audio.finish(); await settle()
    expect(empty.nextSelection).not.toHaveBeenCalled(); expect(empty.audio.play).not.toHaveBeenCalled(); empty.controller.dispose()
    const p = player(); await p.select(); p.audio.finish(); p.audio.finish(); await settle()
    expect(p.nextSelection).toHaveBeenCalledTimes(1); expect(p.controller.state.key).toBe('b'); p.controller.dispose()
  })

  it.each(['before', 'after'] as const)('does not resume if paused %s a queued ended event', async when => {
    const p = player(); await p.select()
    if (when === 'before') p.controller.pause()
    p.audio.finish()
    if (when === 'after') p.controller.pause()
    await settle(); expect(p.nextSelection).not.toHaveBeenCalled()
    expect(p.audio.play).toHaveBeenCalledTimes(1); expect(p.controller.state.desiredPlay).toBe(false); p.controller.dispose()
  })

  it('cancels queued continuation when another media takes focus', async () => {
    const p = player(); await p.select(); p.audio.finish(); p.otherMedia(); await settle()
    expect(p.nextSelection).not.toHaveBeenCalled(); expect(p.audio.play).toHaveBeenCalledTimes(1)
    expect(p.controller.state.playing).toBe(false); p.controller.dispose()
  })

  it('never takes focus back if another media plays while the next QQ song resolves', async () => {
    let resolve!: (url: string) => void, focus: ((audio: PlaybackAudio) => void) | undefined
    const pending = new Promise<string>(yes => { resolve = yes })
    const audio = new AudioFixture(), activateFocus = vi.fn()
    const controller = new MusicPlaybackController({ resolveQq: () => pending, activateFocus,
      subscribeFocus: listener => { focus = listener; return () => {} },
      nextSelection: () => ({ key: 'qq', qq: { songmid: 'next', playlistId: 'playlist', trackId: 'next' } }) })
    controller.attach(audio); await controller.select(localTracks[0]!, true); audio.finish(); await settle()
    expect(controller.state.status).toBe('resolving'); focus!(new AudioFixture())
    resolve('https://dl.stream.qqmusic.qq.com/next.m4a'); await settle()
    expect(audio.play).toHaveBeenCalledTimes(1); expect(activateFocus).toHaveBeenCalledTimes(1)
    expect(controller.state.desiredPlay).toBe(false); controller.dispose()
  })
})

describe('random playlist index boundaries', () => {
  it('makes every other index reachable without the current track at both RNG boundaries', () => {
    for (let current = 0; current < 4; current++) {
      const choices = [0, 1 / 3, 2 / 3, .999999].map(value => nextMusicIndex(current, 4, 'shuffle', () => value))
      expect(new Set(choices)).toEqual(new Set([0, 1, 2, 3].filter(index => index !== current)))
    }
  })
})
