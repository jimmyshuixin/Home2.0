export interface QqPlaybackRequest { songmid: string; playlistId: string; trackId: string }
export interface MusicSelection { key: string; source?: string; qq?: QqPlaybackRequest }
export interface MusicPlaybackState {
  key: string | null; source?: string; status: 'idle' | 'resolving' | 'ready' | 'playing' | 'paused' | 'blocked' | 'error'
  desiredPlay: boolean; playing: boolean; position: number; duration: number | null; error: string
}
export interface PlaybackAudio extends EventTarget {
  src: string; currentSrc: string; paused: boolean; ended: boolean; currentTime: number; duration: number
  error: { code: number } | null
  load(): void; pause(): void; play(): Promise<void>; removeAttribute(name: string): void
}
export const emptyPlaybackState = (): MusicPlaybackState => ({ key: null, status: 'idle', desiredPlay: false, playing: false, position: 0, duration: null, error: '' })
interface PlaybackOptions {
  resolveQq(input: QqPlaybackRequest, signal: AbortSignal): Promise<string>
  onState?(state: MusicPlaybackState): void
  activateFocus?(audio: PlaybackAudio): void
  subscribeFocus?(listener: (audio: PlaybackAudio) => void): () => void
}
function safeQqUrl(value: string): string {
  const url = new URL(value)
  if (value.length > 12000 || /[\u0000-\u0020\\]/u.test(value) || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !(url.hostname === 'qq.com' || url.hostname.endsWith('.qq.com'))) throw new Error('QQ_UNAVAILABLE')
  return url.href
}
function resolutionMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'QQ_BROWSER_UNSUPPORTED') return '当前浏览器暂时无法播放 QQ 音乐，请前往原平台聆听。'
  return 'QQ 音乐暂时未提供这首歌的可用播放地址，请重试、切换站内歌单，或前往原平台聆听。'
}

/** One instance belongs to one client Nuxt app. No promise, token or temporary URL is persisted. */
export class MusicPlaybackController {
  private stateValue = emptyPlaybackState()
  private selection: MusicSelection | null = null
  private audio: PlaybackAudio | null = null
  private generation = 0
  private resolverAbort: AbortController | null = null
  private playPromise: Promise<void> | null = null
  private assignedSource: string | undefined
  private pendingSeek: { generation: number; position: number } | null = null
  private recoveryCount = 0
  private disposed = false
  private removeFocus: (() => void) | undefined
  private readonly events = ['play', 'playing', 'pause', 'ended', 'timeupdate', 'durationchange', 'loadedmetadata', 'error']

  constructor(private readonly options: PlaybackOptions) {
    this.removeFocus = options.subscribeFocus?.(audio => { if (audio !== this.audio) this.pause() })
  }
  get state(): MusicPlaybackState { return { ...this.stateValue } }
  private update(values: Partial<MusicPlaybackState>): void { this.stateValue = { ...this.stateValue, ...values }; this.options.onState?.(this.state) }
  private cancel(): number {
    this.generation++; this.resolverAbort?.abort(); this.resolverAbort = null; this.playPromise = null; this.pendingSeek = null
    return this.generation
  }
  private current(generation: number, key: string): boolean { return !this.disposed && this.generation === generation && this.selection?.key === key }

  attach(audio: PlaybackAudio): void {
    if (this.audio === audio || this.disposed) return
    this.detach(); this.audio = audio
    for (const event of this.events) audio.addEventListener(event, this.handleEvent)
    this.assignedSource = undefined
    if (this.stateValue.source) this.assignSource(this.stateValue.source, this.stateValue.position)
  }
  detach(): void {
    if (!this.audio) return
    this.pause()
    for (const event of this.events) this.audio.removeEventListener(event, this.handleEvent)
    this.audio = null; this.assignedSource = undefined
  }
  select(selection: MusicSelection | null, start = false): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (selection?.key === this.selection?.key) return start ? this.play() : Promise.resolve()
    this.cancel(); this.audio?.pause(); this.selection = selection; this.recoveryCount = 0
    // A QQ descriptor takes precedence over its old cloud stream URL.
    const source = selection?.qq ? undefined : selection?.source
    this.update({ ...emptyPlaybackState(), key: selection?.key ?? null, source, status: source ? 'ready' : 'idle' })
    this.assignSource(source, 0)
    return start ? this.play() : Promise.resolve()
  }
  play(): Promise<void> {
    if (this.disposed || !this.selection || !this.audio) return Promise.resolve()
    if (this.playPromise) return this.playPromise
    if (!this.audio.paused && !this.audio.ended) return Promise.resolve()
    this.recoveryCount = 0
    return this.beginPlay(false, this.stateValue.position)
  }
  pause(): void {
    if (this.disposed) return
    this.cancel(); this.audio?.pause()
    this.update({ desiredPlay: false, playing: false, status: this.stateValue.source ? 'paused' : 'idle', error: '' })
  }
  toggle(): Promise<void> {
    if (this.stateValue.desiredPlay || this.audio && !this.audio.paused && !this.audio.ended) { this.pause(); return Promise.resolve() }
    return this.play()
  }
  retry(): Promise<void> {
    if (!this.selection) return Promise.resolve()
    if (this.stateValue.status === 'blocked') return this.play()
    this.cancel(); this.audio?.pause(); this.recoveryCount = 0
    return this.beginPlay(Boolean(this.selection.qq), this.stateValue.position)
  }
  seek(position: number): void {
    if (!this.audio || !Number.isFinite(this.audio.duration) || !Number.isFinite(position)) return
    this.audio.currentTime = Math.max(0, Math.min(this.audio.duration, position)); this.sync()
  }
  private assignSource(source: string | undefined, position: number): void {
    const audio = this.audio
    if (!audio || source === this.assignedSource) return
    this.assignedSource = source
    this.pendingSeek = source && position > 0 ? { generation: this.generation, position } : null
    if (source) audio.src = source
    else audio.removeAttribute('src')
    audio.load()
  }
  private beginPlay(forceResolve: boolean, position: number): Promise<void> {
    const audio = this.audio, selection = this.selection
    if (!audio || !selection || this.disposed) return Promise.resolve()
    const generation = this.generation, key = selection.key
    this.update({ desiredPlay: true, error: '' })
    const execute = async () => {
      if (!this.current(generation, key) || !this.stateValue.desiredPlay) return
      let source = this.stateValue.source
      if (selection.qq && (forceResolve || !source)) {
        const abort = new AbortController(); this.resolverAbort = abort
        this.update({ status: 'resolving', playing: false })
        try { source = safeQqUrl(await this.options.resolveQq(selection.qq, abort.signal)) }
        catch (error) {
          if (this.current(generation, key) && !abort.signal.aborted) this.update({ desiredPlay: false, status: 'error', error: resolutionMessage(error) })
          return
        } finally { if (this.resolverAbort === abort) this.resolverAbort = null }
      }
      if (!source || !this.current(generation, key) || !this.stateValue.desiredPlay) return
      this.update({ source, status: 'ready' }); this.assignSource(source, position)
      if (!this.current(generation, key) || !this.stateValue.desiredPlay) return
      this.options.activateFocus?.(audio)
      try {
        await audio.play()
        if (this.current(generation, key) && this.stateValue.desiredPlay) this.sync()
      } catch (error) {
        if (!this.current(generation, key)) return
        const blocked = error instanceof Error && error.name === 'NotAllowedError'
        this.update({ desiredPlay: false, playing: false, status: blocked ? 'blocked' : 'error', error: blocked ? '播放已准备好，请再次点击播放。浏览器需要一次新的点击才能开始聆听。' : '歌曲暂时无法播放，请重试或切换歌单。' })
      }
    }
    // Defer execution one microtask so every caller observes the same in-flight promise.
    const promise = Promise.resolve().then(execute).finally(() => { if (this.playPromise === promise) this.playPromise = null })
    this.playPromise = promise
    return promise
  }
  private sync(): void {
    const audio = this.audio
    if (!audio) return
    const playing = !audio.paused && !audio.ended
    this.update({ playing, position: Number.isFinite(audio.currentTime) ? audio.currentTime : 0, duration: Number.isFinite(audio.duration) ? audio.duration : null,
      ...(playing ? { status: 'playing' as const } : this.stateValue.status === 'playing' ? { status: 'paused' as const } : {}) })
  }
  private handleEvent = (event: Event): void => {
    const audio = this.audio
    if (!audio || event.target !== audio || this.disposed) return
    if (event.type === 'error') {
      if (!audio.error || !this.selection || !this.assignedSource || this.stateValue.source !== this.assignedSource) return
      if (this.selection.qq && this.stateValue.desiredPlay && this.recoveryCount < 1) {
        const position = Number.isFinite(audio.currentTime) ? audio.currentTime : this.stateValue.position
        this.recoveryCount++; this.cancel(); audio.pause(); void this.beginPlay(true, position)
      } else {
        this.cancel(); audio.pause(); this.update({ desiredPlay: false, playing: false, status: 'error', error: '歌曲暂时无法播放，请重试或切换歌单。' })
      }
      return
    }
    if (event.type === 'loadedmetadata' && this.pendingSeek?.generation === this.generation && Number.isFinite(audio.duration)) {
      const position = this.pendingSeek.position; this.pendingSeek = null
      audio.currentTime = Math.max(0, Math.min(audio.duration, position))
    }
    if (event.type === 'ended') this.update({ desiredPlay: false, status: 'paused' })
    if ((event.type === 'play' || event.type === 'playing') && !this.stateValue.desiredPlay) audio.pause()
    this.sync()
  }
  dispose(): void { if (this.disposed) return; this.detach(); this.cancel(); this.removeFocus?.(); this.removeFocus = undefined; this.disposed = true }
}

/** Shared controls use one sequence so late playlist/refresh responses cannot win a newer selection. */
export class MusicRequestSequence {
  private selection = 0
  private refresh = 0
  beginSelection(): number { return ++this.selection }
  currentSelection(value: number): boolean { return value === this.selection }
  beginRefresh(): { refresh: number; selection: number } { return { refresh: ++this.refresh, selection: this.selection } }
  currentRefresh(value: { refresh: number; selection: number }): boolean { return value.refresh === this.refresh && value.selection === this.selection }
}
