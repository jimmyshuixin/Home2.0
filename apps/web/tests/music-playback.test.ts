import { afterEach, describe, expect, it, vi } from 'vitest'
import { MusicPlaybackController, MusicRequestSequence, type MusicSelection, type PlaybackAudio } from '../lib/music-playback'
import { MediaFocusManager } from '../lib/media-focus'

class FakeAudio extends EventTarget implements PlaybackAudio {
  src = ''; currentSrc = ''; paused = true; ended = false; currentTime = 0; duration = NaN
  error: { code: number } | null = null
  load = vi.fn(() => { this.currentSrc = this.src; this.currentTime = 0; this.duration = this.src ? 202 : NaN; this.error = null; this.dispatchEvent(new Event('loadedmetadata')) })
  pause = vi.fn(() => { const changed = !this.paused; this.paused = true; if (changed) this.dispatchEvent(new Event('pause')) })
  play = vi.fn(async () => { this.paused = false; this.ended = false; this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')) })
  removeAttribute(name: string) { if (name === 'src') this.src = '' }
  fail() { this.error = { code: 2 }; this.dispatchEvent(new Event('error')) }
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const qq = (id: string): MusicSelection => ({ key: `release:playlist:${id}`, qq: { songmid: id, playlistId: 'playlist', trackId: id } })
const direct: MusicSelection = { key: 'release:local:one', source: '/api/v1/media/asset/playback' }
const url = (id: string) => `https://dl.stream.qqmusic.qq.com/${id}.m4a?vkey=private-temporary-value`
const unavailable = (code = 'QQ_UNAVAILABLE') => Object.assign(new Error('PRIVATE provider content'), { code })

afterEach(() => vi.useRealTimers())

describe('shared asynchronous music controller', () => {
  it('does not resolve QQ or play media on selection or attachment alone', async () => {
    const resolveQq = vi.fn(), audio = new FakeAudio(), controller = new MusicPlaybackController({ resolveQq })
    await controller.select(qq('A')); controller.attach(audio); await settle()
    expect(resolveQq).not.toHaveBeenCalled(); expect(audio.play).not.toHaveBeenCalled(); expect(controller.state.desiredPlay).toBe(false)
    controller.dispose()
  })

  it('allows only the latest selected track to assign a URL and play', async () => {
    const a = deferred<string>(), b = deferred<string>(), audio = new FakeAudio()
    const resolveQq = vi.fn().mockImplementation(input => input.songmid === 'A' ? a.promise : b.promise)
    const controller = new MusicPlaybackController({ resolveQq }); controller.attach(audio)
    const old = controller.select(qq('A'), true); await settle()
    const current = controller.select(qq('B'), true); await settle()
    b.resolve(url('B')); await current; a.resolve(url('A')); await old
    expect(controller.state.key).toBe(qq('B').key); expect(audio.src).toBe(url('B')); expect(audio.play).toHaveBeenCalledTimes(1)
    expect(resolveQq.mock.calls[0]![1].aborted).toBe(true); controller.dispose()
  })

  it('ignores a stale failure after another track is already playing', async () => {
    const a = deferred<string>(), b = deferred<string>(), audio = new FakeAudio()
    const controller = new MusicPlaybackController({ resolveQq: input => input.songmid === 'A' ? a.promise : b.promise }); controller.attach(audio)
    const old = controller.select(qq('A'), true); await settle(); const current = controller.select(qq('B'), true); await settle()
    b.resolve(url('B')); await current; a.reject(new Error('PRIVATE upstream response')); await old
    expect(controller.state.error).toBe(''); expect(controller.state.playing).toBe(true); controller.dispose()
  })

  it('shares one in-flight play promise across controls and cancels on a second toggle', async () => {
    const result = deferred<string>(), resolveQq = vi.fn().mockReturnValue(result.promise), audio = new FakeAudio()
    const controller = new MusicPlaybackController({ resolveQq }); controller.attach(audio); await controller.select(qq('A'))
    const first = controller.play(), second = controller.play(); expect(first).toBe(second); await settle()
    expect(resolveQq).toHaveBeenCalledTimes(1); await controller.toggle(); result.resolve(url('A')); await first
    expect(audio.play).not.toHaveBeenCalled(); expect(controller.state.desiredPlay).toBe(false); controller.dispose()
  })

  it('does not start even a resolver when an immediate pause cancels the queued intent', async () => {
    const resolveQq = vi.fn(), audio = new FakeAudio(), controller = new MusicPlaybackController({ resolveQq }); controller.attach(audio)
    const pending = controller.select(qq('A'), true); controller.pause(); await pending
    expect(resolveQq).not.toHaveBeenCalled(); expect(audio.play).not.toHaveBeenCalled(); controller.dispose()
  })

  it('preserves the prepared URL after NotAllowedError and waits for another explicit click', async () => {
    const resolveQq = vi.fn().mockResolvedValue(url('A')), audio = new FakeAudio()
    audio.play.mockRejectedValueOnce(new DOMException('private browser detail', 'NotAllowedError'))
    const controller = new MusicPlaybackController({ resolveQq }); controller.attach(audio); await controller.select(qq('A'), true)
    expect(controller.state.status).toBe('blocked'); expect(controller.state.error).toContain('再次点击播放'); expect(controller.state.desiredPlay).toBe(false)
    expect(controller.state.error).not.toContain('private browser detail'); await controller.play()
    expect(resolveQq).toHaveBeenCalledTimes(1); expect(audio.play).toHaveBeenCalledTimes(2); expect(controller.state.playing).toBe(true); controller.dispose()
  })

  it('cancels pending music when another media activates without taking its focus back', async () => {
    let notify: ((audio: PlaybackAudio) => void) | undefined
    const result = deferred<string>(), audio = new FakeAudio(), other = new FakeAudio(), activateFocus = vi.fn()
    const controller = new MusicPlaybackController({ resolveQq: () => result.promise, activateFocus, subscribeFocus: listener => { notify = listener; return () => { notify = undefined } } })
    controller.attach(audio); const pending = controller.select(qq('A'), true); await settle(); notify!(other); result.resolve(url('A')); await pending
    expect(audio.play).not.toHaveBeenCalled(); expect(activateFocus).not.toHaveBeenCalled(); expect(controller.state.desiredPlay).toBe(false)
    controller.dispose(); expect(notify).toBeUndefined()
  })

  it('keeps local playback synchronous with its source and preserves pause/resume position', async () => {
    const resolveQq = vi.fn(), audio = new FakeAudio(), controller = new MusicPlaybackController({ resolveQq }); controller.attach(audio)
    await controller.select(direct, true); audio.currentTime = 31; audio.dispatchEvent(new Event('timeupdate')); controller.pause()
    const loads = audio.load.mock.calls.length; await controller.play()
    expect(resolveQq).not.toHaveBeenCalled(); expect(audio.currentTime).toBe(31); expect(audio.load).toHaveBeenCalledTimes(loads); expect(controller.state.playing).toBe(true); controller.dispose()
  })

  it('refreshes a failed temporary QQ URL once, restores position, and stops on the second failure', async () => {
    const resolveQq = vi.fn().mockResolvedValueOnce(url('old')).mockResolvedValueOnce(url('fresh')), audio = new FakeAudio()
    const controller = new MusicPlaybackController({ resolveQq }); controller.attach(audio); await controller.select(qq('A'), true)
    audio.currentTime = 31; audio.fail(); await settle()
    expect(resolveQq).toHaveBeenCalledTimes(2); expect(audio.src).toBe(url('fresh')); expect(audio.currentTime).toBe(31); expect(controller.state.playing).toBe(true)
    audio.fail(); await settle(); expect(resolveQq).toHaveBeenCalledTimes(2); expect(controller.state.status).toBe('error'); expect(controller.state.desiredPlay).toBe(false); controller.dispose()
  })

  it('reloads a failed audio element when QQ returns the same address and allows an explicit fresh retry', async () => {
    const resolveQq = vi.fn().mockResolvedValue(url('A')), audio = new FakeAudio()
    const controller = new MusicPlaybackController({ resolveQq }); controller.attach(audio); await controller.select(qq('A'), true)
    const loads = audio.load.mock.calls.length
    audio.currentTime = 31; audio.fail(); await settle()
    expect(audio.load).toHaveBeenCalledTimes(loads + 1); expect(audio.error).toBeNull(); expect(audio.currentTime).toBe(31)
    expect(controller.state.playing).toBe(true)
    audio.fail(); await settle(); expect(controller.state.status).toBe('error')
    await controller.play()
    expect(resolveQq).toHaveBeenCalledTimes(3); expect(audio.load).toHaveBeenCalledTimes(loads + 2)
    expect(controller.state.playing).toBe(true); controller.dispose()
  })

  it.each(['QQ_UNAVAILABLE', 'QQ_TIMEOUT'])('recovers a transient %s once within the original play request', async code => {
    vi.useFakeTimers()
    const resolveQq = vi.fn().mockRejectedValueOnce(unavailable(code)).mockResolvedValueOnce(url('A')), audio = new FakeAudio()
    const controller = new MusicPlaybackController({ resolveQq }); controller.attach(audio); await controller.select(qq('A'))
    const first = controller.play(); await settle()
    expect(controller.state).toMatchObject({ status: 'resolving', desiredPlay: true, error: '' })
    expect(controller.play()).toBe(first); expect(resolveQq).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(350); await first
    expect(resolveQq).toHaveBeenCalledTimes(2); expect(audio.play).toHaveBeenCalledTimes(1)
    expect(controller.state).toMatchObject({ status: 'playing', playing: true, error: '' }); controller.dispose()
  })

  it.each(['pause', 'change', 'dispose'] as const)('cancels a queued resolution retry on %s', async action => {
    vi.useFakeTimers()
    const resolveQq = vi.fn().mockRejectedValue(unavailable()), audio = new FakeAudio()
    const controller = new MusicPlaybackController({ resolveQq }); controller.attach(audio)
    const pending = controller.select(qq('A'), true); await settle()
    if (action === 'change') await controller.select(qq('B'))
    else controller[action]()
    await pending; await vi.advanceTimersByTimeAsync(1000)
    expect(resolveQq).toHaveBeenCalledTimes(1); expect(resolveQq.mock.calls[0]![1].aborted).toBe(true)
    expect(audio.play).not.toHaveBeenCalled(); expect(controller.state.desiredPlay).toBe(false)
    expect(vi.getTimerCount()).toBe(0); controller.dispose()
  })

  it('ignores a stale retried resolution after another track starts playing', async () => {
    vi.useFakeTimers()
    const retried = deferred<string>(), audio = new FakeAudio()
    const resolveQq = vi.fn().mockRejectedValueOnce(unavailable()).mockReturnValueOnce(retried.promise).mockResolvedValueOnce(url('B'))
    const controller = new MusicPlaybackController({ resolveQq }); controller.attach(audio)
    const old = controller.select(qq('A'), true); await settle(); await vi.advanceTimersByTimeAsync(350)
    await controller.select(qq('B'), true); retried.resolve(url('A')); await old
    expect(resolveQq.mock.calls[1]![1].aborted).toBe(true); expect(audio.src).toBe(url('B'))
    expect(audio.play).toHaveBeenCalledTimes(1); expect(controller.state.error).toBe(''); controller.dispose()
  })

  it.each(['http://qq.com/song', 'https://evil.invalid/song', 'https://qq.com.evil.invalid/song', 'https://user:secret@qq.com/song', 'https://qq.com:444/song', 'https://qq.com/song#fragment'])('rejects unsafe resolver output %s', async source => {
    const audio = new FakeAudio(), controller = new MusicPlaybackController({ resolveQq: async () => source }); controller.attach(audio)
    await controller.select(qq('A'), true); expect(audio.play).not.toHaveBeenCalled(); expect(controller.state.status).toBe('error'); expect(controller.state.error).not.toContain(source); controller.dispose()
  })

  it.each(['QQ_BROWSER_UNSUPPORTED', 'QQ_UNAVAILABLE', 'QQ_TIMEOUT'])('keeps provider refusal %s as a visible failure', async code => {
    vi.useFakeTimers()
    const resolveQq = vi.fn().mockRejectedValue(unavailable(code)), audio = new FakeAudio(), controller = new MusicPlaybackController({ resolveQq }); controller.attach(audio)
    const pending = controller.select(qq('A'), true); await settle(); await vi.advanceTimersByTimeAsync(350); await pending
    expect(resolveQq).toHaveBeenCalledTimes(code === 'QQ_BROWSER_UNSUPPORTED' ? 1 : 2)
    expect(audio.play).not.toHaveBeenCalled(); expect(controller.state.status).toBe('error'); expect(controller.state.error).toContain(code === 'QQ_BROWSER_UNSUPPORTED' ? '当前浏览器暂时无法播放 QQ 音乐' : '未提供'); expect(controller.state.error).not.toContain('PRIVATE'); controller.dispose()
  })

  it('pauses a late native play event after the user has cancelled', async () => {
    const audio = new FakeAudio(), controller = new MusicPlaybackController({ resolveQq: vi.fn() }); controller.attach(audio); await controller.select(direct)
    controller.pause(); audio.paused = false; audio.dispatchEvent(new Event('play')); expect(audio.paused).toBe(true); expect(controller.state.playing).toBe(false); controller.dispose()
  })
})

describe('playlist selection and shared focus boundaries', () => {
  it('ignores an older playlist response and an initial refresh after a user changes tracks', async () => {
    const sequence = new MusicRequestSequence(), old = deferred<string>(), current = deferred<string>(); let selected = ''
    async function apply(pending: Promise<string>) { const ticket = sequence.beginSelection(); const id = await pending; if (sequence.currentSelection(ticket)) selected = id }
    const refresh = sequence.beginRefresh(), first = apply(old.promise), second = apply(current.promise)
    current.resolve('B'); await second; old.resolve('A'); await first
    expect(selected).toBe('B'); expect(sequence.currentRefresh(refresh)).toBe(false)
  })

  it('notifies shared controls on every media activation and unsubscribes cleanly', () => {
    const manager = new MediaFocusManager(), music = new FakeAudio(), video = new FakeAudio(), listener = vi.fn(), off = manager.onActivate(listener)
    manager.activate(music as unknown as HTMLMediaElement); manager.activate(video as unknown as HTMLMediaElement)
    expect(music.pause).toHaveBeenCalledTimes(1); expect(listener).toHaveBeenLastCalledWith(video)
    off(); manager.activate(music as unknown as HTMLMediaElement); expect(listener).toHaveBeenCalledTimes(2)
  })
})
