import { assetVariant, safeUrl, site, type Track, type Playlist } from '~/lib/site'
export function useMusic() {
  const api = useApi()
  const playlists = useState<Playlist[]>('music-playlists', () => site.playlists)
  const playlistId = useState<string>('music-playlist', () => site.playlists.find((p) => p.isDefault)?.id || site.playlists[0]?.id || '')
  const tracks = useState<Track[]>('music-tracks', () => site.playlists.find((p) => p.id === playlistId.value)?.tracks || [])
  const index = useState('music-index', () => 0)
  const playing = useState('music-playing', () => false)
  const duration = useState('music-duration', () => NaN)
  const position = useState('music-position', () => 0)
  const volume = useState('music-volume', () => .7)
  const loading = useState('music-loading', () => false)
  const error = useState('music-error', () => '')
  const repeat = useState('music-repeat', () => false)
  const track = computed(() => tracks.value[index.value])
  const lyricsCache = useState<Record<string, { status: 'loading' | 'ready' | 'error'; text: string; error: string }>>('music-lyrics-cache', () => ({}))
  const lyricsRecord = computed(() => track.value?.lyricsUrl ? lyricsCache.value[track.value.lyricsUrl] : undefined)
  const lyrics = computed(() => track.value?.lyrics || lyricsRecord.value?.text || '')
  const lyricsLoading = computed(() => lyricsRecord.value?.status === 'loading')
  const lyricsError = computed(() => lyricsRecord.value?.error || '')
  const source = computed(() => safeUrl(track.value?.url || track.value?.audioUrl) || assetVariant(track.value?.assetId, 'playback')?.url)
  const element = () => import.meta.client ? document.getElementById('site-music') as HTMLAudioElement | null : null
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
    loading.value = true; error.value = ''
    try {
      playlists.value = (await api<(Playlist & { name?: string })[]>('/playlists')).data.map((playlist) => ({ ...playlist, title: playlist.name || playlist.title }))
      if (!playlists.value.some((p) => p.id === playlistId.value)) playlistId.value = playlists.value.find((p) => p.isDefault)?.id || playlists.value[0]?.id || ''
      if (playlistId.value) await selectPlaylist(playlistId.value)
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '歌单暂时无法加载。' }
    finally { loading.value = false }
  }
  async function selectPlaylist(id: string) {
    loading.value = true; error.value = ''
    try {
      const result = (await api<Track[] | { tracks: Track[] }>(`/music/playlist/${encodeURIComponent(id)}`)).data
      element()?.pause(); tracks.value = Array.isArray(result) ? result : result.tracks
      playlistId.value = id; index.value = 0; position.value = 0; duration.value = NaN
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '歌单暂时无法加载，已保留之前的曲目。' }
    finally { loading.value = false }
  }
  async function play() {
    if (!source.value) return
    const audio = element(); if (!audio) return
    error.value = ''; useNuxtApp().$mediaFocus?.activate(audio)
    try { await audio.play() } catch { error.value = '暂时无法播放这首歌，请重试或选择其他曲目。' }
  }
  async function selectTrack(next: number, start = true) {
    if (next < 0 || next >= tracks.value.length) return
    element()?.pause(); index.value = next; position.value = 0; duration.value = NaN
    await nextTick(); element()?.load(); if (start) await play()
  }
  function toggle() { const audio = element(); if (!audio) return; if (audio.paused) void play(); else audio.pause() }
  function seek(value: number) { const audio = element(); if (audio && Number.isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, Math.max(0, value)) }
  function setVolume(value: number) { volume.value = value; const audio = element(); if (audio) audio.volume = value }
  function previous() { void selectTrack((index.value - 1 + tracks.value.length) % tracks.value.length) }
  function next() { void selectTrack((index.value + 1) % tracks.value.length) }
  return { playlists, playlistId, tracks, track, source, index, playing, duration, position, volume, loading, error, repeat, lyrics, lyricsLoading, lyricsError, loadLyrics, refresh, selectPlaylist, selectTrack, toggle, seek, setVolume, previous, next, play }
}
