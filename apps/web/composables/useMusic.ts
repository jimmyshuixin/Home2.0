import { assetVariant, safeUrl, site, type Track, type Playlist } from '~/lib/site'
import { emptyPlaybackState, MusicPlaybackController, MusicRequestSequence, type MusicPlaybackState, type MusicSelection } from '~/lib/music-playback'
import { resolveQqBrowser } from '~/lib/qq-browser-resolver'
import { preferredMusicPlaylist, nextMusicIndex, musicModes, musicModeLabels, type MusicMode } from '~/lib/music-playlist'

interface ClientMusicRuntime { controller: MusicPlaybackController; requests: MusicRequestSequence; audio?: HTMLAudioElement }
// WeakMap keys are individual Nuxt apps. Controllers/promises never enter SSR state.
const clientRuntimes = new WeakMap<object, ClientMusicRuntime>()

export function useMusic() {
  const nuxt = useNuxtApp(), api = useApi()
  const playlists = useState<Playlist[]>('music-playlists', () => site.playlists)
  const playlistId = useState<string>('music-playlist', () => preferredMusicPlaylist(site.playlists))
  const playlistChosen = useState('music-playlist-chosen', () => false)
  const tracks = useState<Track[]>('music-tracks', () => site.playlists.find(p => p.id === playlistId.value)?.tracks || [])
  const index = useState('music-index', () => 0)
  const playback = useState<MusicPlaybackState>('music-playback', emptyPlaybackState)
  const volume = useState('music-volume', () => .7)
  const loading = useState('music-loading', () => false)
  const playlistError = useState('music-playlist-error', () => '')
  const mode = useState<MusicMode>('music-mode', () => 'sequential')
  const modeLabel = computed(() => musicModeLabels[mode.value])
  const nextMode = computed(() => musicModes[(musicModes.indexOf(mode.value) + 1) % musicModes.length]!)
  const modeActionLabel = computed(() => `当前：${modeLabel.value}；点击切换为${musicModeLabels[nextMode.value]}`)
  const track = computed(() => tracks.value[index.value])
  const playing = computed(() => playback.value.playing)
  const duration = computed(() => playback.value.duration ?? NaN)
  const position = computed(() => playback.value.position)
  const resolving = computed(() => playback.value.status === 'resolving')
  const pendingPlay = computed(() => playback.value.desiredPlay)
  const error = computed(() => playlistError.value || playback.value.error)
  const source = computed(() => playback.value.source)
  function selection(): MusicSelection | null {
    const value = track.value
    if (!value) return null
    const qq = value.playback?.kind === 'qq-anonymous' && /^[A-Za-z0-9]{1,80}$/u.test(value.playback.songmid)
      ? { songmid: value.playback.songmid, playlistId: playlistId.value, trackId: value.id } : undefined
    const direct = safeUrl(value.url || value.audioUrl) || assetVariant(value.assetId, 'playback')?.url
    return { key: `${site.releaseId}:${playlistId.value}:${value.id}:${qq?.songmid || value.assetId || direct || ''}`, ...(qq ? { qq } : { source: direct }) }
  }
  const canPlay = computed(() => { const value = selection(); return Boolean(value?.qq || value?.source) })
  let runtime = import.meta.client ? clientRuntimes.get(nuxt) : undefined
  if (import.meta.client && !runtime) {
    const controller = new MusicPlaybackController({
      resolveQq: resolveQqBrowser,
      onState: state => { playback.value = state },
      activateFocus: audio => nuxt.$mediaFocus.activate(audio as HTMLAudioElement),
      subscribeFocus: listener => nuxt.$mediaFocus.onActivate(listener),
      nextSelection: () => {
        const following = nextMusicIndex(index.value, tracks.value.length, mode.value)
        if (following === null) return null
        runtime?.requests.beginSelection(); index.value = following
        return selection()
      },
    })
    runtime = { controller, requests: new MusicRequestSequence() }
    clientRuntimes.set(nuxt, runtime)
    void controller.select(selection())
    nuxt.vueApp.onUnmount(() => { controller.dispose(); clientRuntimes.delete(nuxt) })
  }

  const lyricsCache = useState<Record<string, { status: 'loading' | 'ready' | 'error'; text: string; error: string }>>('music-lyrics-cache', () => ({}))
  const lyricsRecord = computed(() => track.value?.lyricsUrl ? lyricsCache.value[track.value.lyricsUrl] : undefined)
  const lyrics = computed(() => track.value?.lyrics || lyricsRecord.value?.text || '')
  const lyricsLoading = computed(() => lyricsRecord.value?.status === 'loading')
  const lyricsError = computed(() => lyricsRecord.value?.error || '')
  async function loadLyrics(force = false) {
    const url = track.value?.lyricsUrl
    if (track.value?.lyrics || !url || !/^\/api\/v1\/music\/lyrics\/[^/?#]+\/[^/?#]+$/.test(url)) return
    if (lyricsCache.value[url]?.status === 'loading' || !force && lyricsCache.value[url]?.status === 'ready') return
    lyricsCache.value[url] = { status: 'loading', text: '', error: '' }
    try {
      const result = (await api<{ lyrics: string }>(url.slice('/api/v1'.length))).data
      if (typeof result.lyrics !== 'string' || result.lyrics.length > 200000) throw new Error('歌词格式暂时无法读取。')
      lyricsCache.value[url] = { status: 'ready', text: result.lyrics, error: '' }
    } catch { lyricsCache.value[url] = { status: 'error', text: '', error: '歌词暂时无法加载，音乐播放不受影响。' } }
  }
  async function refresh() {
    if (!runtime) return
    const request = runtime.requests.beginRefresh()
    loading.value = true; playlistError.value = ''
    try {
      const available = (await api<(Playlist & { name?: string })[]>('/playlists')).data.map(playlist => ({ ...playlist, title: playlist.name || playlist.title }))
      if (!runtime.requests.currentRefresh(request)) return
      playlists.value = available
      const id = preferredMusicPlaylist(available, playlistChosen.value ? playlistId.value : undefined)
      if (id) await loadPlaylist(id)
      else { playlistId.value = ''; tracks.value = []; index.value = 0; await runtime.controller.select(null); loading.value = false }
    } catch { if (runtime.requests.currentRefresh(request)) playlistError.value = '歌单暂时无法加载，请重试。' }
    finally { if (runtime.requests.currentRefresh(request)) loading.value = false }
  }
  async function initialize() {
    // The compiled published snapshot already contains the allowed playlists.
    // Fetch only the selected playlist instead of a serial settings round trip.
    const id = preferredMusicPlaylist(playlists.value)
    if (id) await loadPlaylist(id)
  }
  function selectPlaylist(id: string) {
    playlistChosen.value = true
    return loadPlaylist(id)
  }
  async function loadPlaylist(id: string) {
    if (!runtime) return
    const request = runtime.requests.beginSelection()
    runtime.controller.pause(); loading.value = true; playlistError.value = ''
    try {
      const result = (await api<Track[] | { tracks: Track[] }>(`/music/playlist/${encodeURIComponent(id)}`)).data
      if (!runtime.requests.currentSelection(request)) return
      tracks.value = Array.isArray(result) ? result : result.tracks
      playlistId.value = id; index.value = 0
      await runtime.controller.select(selection())
    } catch { if (runtime.requests.currentSelection(request)) playlistError.value = '歌单暂时无法加载，已保留之前的曲目。' }
    finally { if (runtime.requests.currentSelection(request)) loading.value = false }
  }
  function attach(audio: HTMLAudioElement) { if (runtime) { runtime.audio = audio; audio.volume = volume.value; runtime.controller.attach(audio) } }
  function detach() { if (runtime) { runtime.controller.detach(); runtime.audio = undefined } }
  function beginInteraction() { runtime?.requests.beginSelection(); loading.value = false; playlistError.value = '' }
  function play() { beginInteraction(); return runtime?.controller.play() }
  function toggle() { beginInteraction(); return runtime?.controller.toggle() }
  function retry() { if (playlistError.value) return refresh(); beginInteraction(); return runtime?.controller.retry() }
  function selectTrack(next: number, start = true) {
    if (!runtime || next < 0 || next >= tracks.value.length) return
    runtime.requests.beginSelection(); loading.value = false; playlistError.value = ''; index.value = next
    return runtime.controller.select(selection(), start)
  }
  function seek(value: number) { runtime?.controller.seek(value) }
  function setVolume(value: number) { volume.value = Math.max(0, Math.min(1, value)); if (runtime?.audio) runtime.audio.volume = volume.value }
  function previous() { if (tracks.value.length) void selectTrack((index.value - 1 + tracks.value.length) % tracks.value.length) }
  function next() { const following = nextMusicIndex(index.value, tracks.value.length, mode.value === 'repeat-one' ? 'sequential' : mode.value); if (following !== null) void selectTrack(following) }
  function cycleMode() { mode.value = nextMode.value }
  return { playlists, playlistId, tracks, track, source, canPlay, index, playing, pendingPlay, resolving, duration, position, volume, loading, error, mode, modeLabel, modeActionLabel, cycleMode,
    lyrics, lyricsLoading, lyricsError, loadLyrics, initialize, refresh, selectPlaylist, selectTrack, toggle, seek, setVolume, previous, next, play, retry, attach, detach }
}
