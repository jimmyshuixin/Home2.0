<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import {
  CheckCircle2,
  ListMusic,
  LogIn,
  Pause,
  Play,
  QrCode,
  RefreshCw,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-vue-next';

const props = defineProps({
  song: { type: Object, required: true },
  playlist: { type: Array, default: () => [] },
  playlists: { type: Array, default: () => [] },
  selectedPlaylistKey: { type: String, default: '' },
  lyrics: { type: Array, default: () => [] },
  activeLyricIndex: { type: Number, default: -1 },
  playMode: { type: String, default: 'order' },
  isPlaying: { type: Boolean, required: true },
  isLoading: { type: Boolean, default: false },
  isLibraryOpen: { type: Boolean, default: false },
  isLoggedIn: { type: Boolean, default: false },
  isLoginOpen: { type: Boolean, default: false },
  isPollingLogin: { type: Boolean, default: false },
  loginStatus: { type: String, default: 'idle' },
  loginMessage: { type: String, default: '' },
  qrImage: { type: String, default: '' },
  qrUrl: { type: String, default: '' },
  scanApp: { type: String, default: '' },
  source: { type: String, default: 'local' },
  error: { type: String, default: '' },
  progressText: { type: String, required: true },
});

const emit = defineEmits([
  'toggle',
  'next',
  'previous',
  'toggle-mode',
  'toggle-library',
  'select-playlist',
  'refresh',
  'start-login',
  'cancel-login',
  'logout',
  'load-custom',
]);

const customPlaylistId = ref('');
const lyricScroller = ref(null);

const metaText = computed(() => {
  if (props.isLoading) return 'Loading playlist...';
  if (!props.song.url) return `${props.song.playError || 'No playable URL'} · ${props.progressText}`;
  if (props.error) return `${props.error} · ${props.progressText}`;
  return `${props.song.artist} · ${props.progressText}`;
});

const loginSummary = computed(() => {
  if (props.isLoggedIn) return 'Logged in for playable URLs';
  if (props.isPollingLogin) return 'Waiting for scan confirmation';
  return 'Login when a playlist needs cookies';
});

const submitCustomPlaylist = () => {
  const id = customPlaylistId.value.trim();
  if (!id) return;
  emit('load-custom', id);
  customPlaylistId.value = '';
};

watch(
  () => props.activeLyricIndex,
  async (index) => {
    if (index < 0) return;
    await nextTick();
    lyricScroller.value?.querySelector(`[data-lyric-index="${index}"]`)?.scrollIntoView({
      block: 'center',
      behavior: 'smooth',
    });
  },
);
</script>

<template>
  <aside class="music-dock" :class="{ 'is-expanded': isLibraryOpen }" aria-label="Music player">
    <div class="music-dock-main">
      <img class="music-cover" :src="song.cover" :alt="`${song.name} cover`" />
      <div class="music-meta">
        <strong>{{ song.name }}</strong>
        <span>{{ metaText }}</span>
      </div>
      <div class="music-actions">
        <button type="button" aria-label="Previous song" title="Previous" @click="$emit('previous')">
          <SkipBack :size="18" />
        </button>
        <button class="play-button" type="button" :aria-label="isPlaying ? 'Pause' : 'Play'" :title="isPlaying ? 'Pause' : 'Play'" @click="$emit('toggle')">
          <Pause v-if="isPlaying" :size="20" />
          <Play v-else :size="20" />
        </button>
        <button type="button" aria-label="Next song" title="Next" @click="$emit('next')">
          <SkipForward :size="18" />
        </button>
        <button
          type="button"
          :aria-label="playMode === 'random' ? 'Random playback enabled' : 'Ordered playback enabled'"
          :title="playMode === 'random' ? 'Random' : 'Ordered loop'"
          :class="{ active: playMode === 'random' }"
          @click="$emit('toggle-mode')"
        >
          <Shuffle v-if="playMode === 'random'" :size="18" />
          <Repeat v-else :size="18" />
        </button>
        <button
          type="button"
          :aria-expanded="isLibraryOpen"
          aria-label="Open playlist and lyrics"
          title="Playlist and lyrics"
          @click="$emit('toggle-library')"
        >
          <ListMusic :size="18" />
        </button>
      </div>
    </div>

    <section v-if="isLibraryOpen" class="music-panel">
      <header class="music-panel-header">
        <div>
          <strong>Music Library</strong>
          <span>{{ loginSummary }}</span>
        </div>
        <button type="button" aria-label="Close music library" title="Close" @click="$emit('toggle-library')">
          <X :size="18" />
        </button>
      </header>

      <div class="music-login-row" :class="loginStatus">
        <div>
          <span v-if="isLoggedIn"><CheckCircle2 :size="16" /> Login active</span>
          <span v-else><QrCode :size="16" /> QR login</span>
          <small>{{ loginMessage || 'Scan to refresh music cookies when playback URLs fail.' }}</small>
        </div>
        <button v-if="isLoggedIn" type="button" class="text-button" @click="$emit('logout')">Logout</button>
        <button v-else type="button" class="text-button" :disabled="isPollingLogin" @click="$emit('start-login')">
          <LogIn :size="15" /> {{ isPollingLogin ? 'Polling' : 'Scan' }}
        </button>
      </div>

      <div v-if="isLoginOpen" class="music-qr-box">
        <img v-if="qrImage" :src="qrImage" :alt="`Scan with ${scanApp || 'music app'}`" />
        <a v-else-if="qrUrl" :href="qrUrl" target="_blank" rel="noreferrer">Open login QR</a>
        <span v-else>Creating QR code...</span>
        <button type="button" class="text-button" @click="$emit('cancel-login')">Cancel</button>
      </div>

      <form class="playlist-import" @submit.prevent="submitCustomPlaylist">
        <label for="music-playlist-id">Playlist ID</label>
        <div>
          <input id="music-playlist-id" v-model="customPlaylistId" placeholder="9206816111" inputmode="numeric" />
          <button type="submit">Load</button>
        </div>
      </form>

      <div class="playlist-list" aria-label="Playlist choices">
        <button
          v-for="item in playlists"
          :key="item.key"
          type="button"
          :class="{ active: item.key === selectedPlaylistKey }"
          @click="$emit('select-playlist', item.key)"
        >
          <span>{{ item.name }}</span>
          <small>{{ item.source === 'local' ? 'Local' : item.server }}</small>
        </button>
      </div>

      <div class="playlist-toolbar">
        <span>{{ playlist.length }} tracks · {{ source }}</span>
        <button type="button" class="text-button" :disabled="isLoading" @click="$emit('refresh')">
          <RefreshCw :size="15" /> Refresh
        </button>
      </div>

      <div ref="lyricScroller" class="lyric-box" aria-label="Lyrics">
        <p v-if="!lyrics.length">Lyrics will appear here when the selected playlist includes LRC data.</p>
        <p
          v-for="(line, index) in lyrics"
          v-else
          :key="`${line.time}-${line.text}`"
          :data-lyric-index="index"
          :class="{ active: index === activeLyricIndex }"
        >
          {{ line.text }}
        </p>
      </div>
    </section>
  </aside>
</template>
