import { describe, expect, it, vi } from 'vitest'
import { MediaFocusManager } from '../lib/media-focus'
import { MusicPlaybackController, type PlaybackAudio } from '../lib/music-playback'

class FakeAudio extends EventTarget implements PlaybackAudio {
  src = ''; currentSrc = ''; paused = true; ended = false; currentTime = 0; duration = NaN
  error = null
  load = vi.fn()
  pause = vi.fn(() => { this.paused = true })
  play = vi.fn(async () => { this.paused = false })
  removeAttribute(name: string) { if (name === 'src') this.src = '' }
}

describe('embedded players participate in site media focus', () => {
  it('pauses site audio on opening an embed, unloads that embed when another starts, and never resumes automatically', () => {
    const focus = new MediaFocusManager(), audio = new FakeAudio()
    let iframePresent = true
    const embed = { pause: vi.fn(() => { iframePresent = false; focus.release(embed) }) }
    const secondEmbed = { pause: vi.fn() }
    focus.activate(audio); focus.activate(embed)
    expect(audio.pause).toHaveBeenCalledTimes(1)
    expect(iframePresent).toBe(true)
    focus.activate(embed) // Reloading the same embed keeps focus and must not close it.
    expect(embed.pause).not.toHaveBeenCalled(); expect(audio.pause).toHaveBeenCalledTimes(1)
    focus.activate(secondEmbed)
    expect(iframePresent).toBe(false); expect(embed.pause).toHaveBeenCalledTimes(1)
    focus.release(embed) // A stale component cleanup must not release the new player.
    focus.activate(audio)
    expect(secondEmbed.pause).toHaveBeenCalledTimes(1)
    expect(audio.play).not.toHaveBeenCalled()
  })

  it('unloads the active iframe on stop and does not pause an already released player', () => {
    const focus = new MediaFocusManager(), embed = { pause: vi.fn() }
    focus.activate(embed); focus.stop(); focus.stop()
    expect(embed.pause).toHaveBeenCalledTimes(1)
    focus.activate(embed); focus.release(embed); focus.stop()
    expect(embed.pause).toHaveBeenCalledTimes(1)
  })

  it('cancels unresolved site music when an iframe takes focus, so a late music response cannot interrupt it', async () => {
    const focus = new MediaFocusManager(), audio = new FakeAudio(), embed = { pause: vi.fn() }
    let resolve!: (source: string) => void
    const pending = new Promise<string>(yes => { resolve = yes })
    const controller = new MusicPlaybackController({
      resolveQq: () => pending,
      activateFocus: media => focus.activate(media),
      subscribeFocus: listener => focus.onActivate(listener),
    })
    controller.attach(audio)
    const request = controller.select({ key: 'test', qq: { songmid: 'test', playlistId: 'playlist', trackId: 'track' } }, true)
    expect(controller.state.desiredPlay).toBe(true)
    focus.activate(embed)
    resolve('https://dl.stream.qqmusic.qq.com/test.m4a')
    await request
    expect(audio.play).not.toHaveBeenCalled()
    expect(controller.state.desiredPlay).toBe(false)
    expect(embed.pause).not.toHaveBeenCalled()
    focus.stop(); expect(embed.pause).toHaveBeenCalledTimes(1)
    controller.dispose()
  })
})
