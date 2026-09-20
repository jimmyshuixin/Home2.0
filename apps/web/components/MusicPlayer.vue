<script setup lang="ts">
import { assetVariant, displayTime, safeUrl } from '~/lib/site'
import { parseLyrics } from '~/lib/lyrics'
const music = useMusic()
const { playlists, playlistId, tracks, track, canPlay, index, playing, pendingPlay, resolving, duration, position, volume, loading, error, mode, modeActionLabel, lyrics, lyricsLoading, lyricsError } = music
const progressPercent = computed(() => Number.isFinite(duration.value) && duration.value > 0 && Number.isFinite(position.value) ? Math.max(0, Math.min(100, position.value / duration.value * 100)) : 0)
const volumePercent = computed(() => Number.isFinite(volume.value) ? Math.max(0, Math.min(100, volume.value * 100)) : 0)
const playlistPickerOpen = ref(false), tracksOpen = ref(false), lyricsOpen = ref(false)
const currentPlaylistTitle = computed(() => playlists.value.find(playlist => playlist.id === playlistId.value)?.title || '当前歌单')
async function selectPlaylist(id: string) {
  if (loading.value || id === playlistId.value) return
  await music.selectPlaylist(id)
}
const cover = computed(() => safeUrl(track.value?.coverUrl) || assetVariant(track.value?.coverAssetId, 'thumb')?.url)
const coverFailed = ref(false)
watch(cover, () => { coverFailed.value = false })
const lyricLines = computed(() => parseLyrics(lyrics.value))
const activeLyric = computed(() => { let result = -1; lyricLines.value.forEach((line, i) => { if (line.time >= 0 && line.time <= position.value) result = i }); return result })
watch([lyricsOpen, () => track.value?.id, () => track.value?.lyricsUrl], () => { if (lyricsOpen.value) void music.loadLyrics() })
</script>
<style src="~/assets/ink-music.css"></style>
<template><section class="panel music-panel ink-music-panel" aria-labelledby="music-title"><div class="panel-head"><h3 id="music-title">我的音乐</h3><div><button class="quiet playlist-picker-trigger" aria-label="选择歌单" :title="`当前歌单：${currentPlaylistTitle}`" aria-haspopup="dialog" :aria-expanded="playlistPickerOpen" @click="playlistPickerOpen = true"><SiteIcon name="music" :size="16" /><span>歌单</span></button><button class="quiet music-tab is-current" aria-haspopup="dialog" :aria-expanded="tracksOpen" @click="tracksOpen = true">歌曲</button><button class="quiet music-tab" aria-haspopup="dialog" :aria-expanded="lyricsOpen" @click="lyricsOpen = true">歌词</button></div></div>
  <div class="track"><img v-if="cover && !coverFailed" :src="cover" class="track-cover" alt="" width="76" height="76" loading="lazy" referrerpolicy="no-referrer" @error="coverFailed = true"><span v-else class="disc" aria-hidden="true"><SiteIcon name="music" :size="30" /></span><div><h4>{{ track?.title || '选择一首，慢慢听。' }}</h4><p>{{ track?.artist || (loading ? '正在加载歌单' : '未选择曲目') }}</p></div></div>
  <input class="progress music-progress" type="range" min="0" :max="Number.isFinite(duration) ? duration : 0" :value="position" :style="{ '--played': `${progressPercent}%` }" :disabled="!Number.isFinite(duration)" aria-label="播放进度" @input="music.seek(Number(($event.target as HTMLInputElement).value))">
  <div class="times"><span>{{ displayTime(position) }}</span><span>{{ displayTime(duration) }}</span></div>
  <div class="controls"><button class="icon-button playback-mode" :aria-label="modeActionLabel" :title="modeActionLabel" @click="music.cycleMode"><SiteIcon :name="mode === 'shuffle' ? 'shuffle' : mode === 'repeat-one' ? 'repeat-one' : 'sequence'" /></button><button class="icon-button" aria-label="上一首" :disabled="tracks.length < 2" @click="music.previous"><SiteIcon name="previous" /></button><button class="play-button primary" :class="{ 'is-playing': pendingPlay }" :aria-label="resolving ? '取消音乐加载' : pendingPlay ? '暂停音乐' : '播放音乐'" :aria-busy="resolving" :disabled="!canPlay" @click="music.toggle"><SiteIcon :name="pendingPlay ? 'pause' : 'play'" /></button><button class="icon-button" aria-label="下一首" :disabled="tracks.length < 2" @click="music.next"><SiteIcon name="next" /></button><label class="volume-desktop"><SiteIcon name="volume" /><input type="range" class="volume" min="0" max="1" step=".05" :value="volume" :style="{ '--volume': `${volumePercent}%` }" aria-label="音乐音量" @input="music.setVolume(Number(($event.target as HTMLInputElement).value))"></label></div>
  <p v-if="error" class="feedback error" role="status">{{ error }} <button class="quiet" :disabled="loading" @click="music.retry">重试</button></p><div class="music-footer"><span>{{ resolving ? '正在准备播放，可点击暂停取消' : playing ? '正在播放' : '点击播放后才开始聆听' }}</span><a v-if="safeUrl(track?.sourceUrl)" :href="safeUrl(track?.sourceUrl)" target="_blank" rel="noopener noreferrer">原平台 <SiteIcon name="external" :size="16" /></a></div>
  <AppDialog v-model="playlistPickerOpen" title="选择歌单">
    <p class="playlist-picker-current">当前歌单：{{ currentPlaylistTitle }}</p>
    <p v-if="loading" role="status">正在加载歌单…</p>
    <p v-else-if="!playlists.length" class="muted" role="status">尚无公开歌单。</p>
    <ul v-if="playlists.length" class="playlist-picker-list" aria-label="公开歌单">
      <li v-for="playlist in playlists" :key="playlist.id"><button :aria-pressed="playlist.id === playlistId" :disabled="loading" @click="selectPlaylist(playlist.id)"><span class="playlist-picker-name">{{ playlist.title }}</span><span class="playlist-picker-state">{{ playlist.id === playlistId ? '当前歌单' : '选择' }}</span></button></li>
    </ul>
    <p v-if="error" class="feedback error" role="status">{{ error }} <button class="quiet" :disabled="loading" @click="music.retry">重试</button></p>
  </AppDialog>
  <AppDialog v-model="tracksOpen" title="歌曲列表"><p class="playlist-picker-current">{{ currentPlaylistTitle }}</p><p v-if="loading" role="status">正在加载曲目…</p><p v-else-if="!tracks.length" class="muted">这个歌单暂时没有可播放曲目。</p><ol class="track-list"><li v-for="(item, i) in tracks" :key="item.id"><button :aria-current="i === index ? 'true' : undefined" @click="i === index ? music.toggle() : music.selectTrack(i)"><span>{{ item.title }}<small>{{ item.artist }}</small></span><SiteIcon :name="i === index && playing ? 'pause' : 'play'" /></button></li></ol><p v-if="error" class="feedback error" role="status">{{ error }}</p></AppDialog>
  <AppDialog v-model="lyricsOpen" :title="track?.title ? `${track.title} · 歌词` : '歌词'"><p v-if="lyricsLoading" class="muted" role="status">正在读取歌词…</p><p v-else-if="lyricsError" class="feedback error" role="status">{{ lyricsError }} <button class="quiet" @click="music.loadLyrics(true)">重试</button></p><div v-else-if="lyricLines.length" class="lyrics"><p v-for="(line, i) in lyricLines" :key="i" :class="{ current: i === activeLyric }">{{ line.text }}</p></div><p v-else class="muted">这首歌暂时没有歌词，仍可继续聆听。</p></AppDialog>
</section></template>
