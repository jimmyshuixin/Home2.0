<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import {
  CheckCircle2,
  ListMusic,
  LogIn,
  Music2,
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
  selectedPlaylistName: { type: String, default: '' },
  currentIndex: { type: Number, default: 0 },
  currentTime: { type: Number, default: 0 },
  duration: { type: Number, default: 0 },
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
  instanceId: { type: String, default: 'default' },
});

const emit = defineEmits([
  'toggle',
  'next',
  'previous',
  'toggle-mode',
  'toggle-library',
  'select-playlist',
  'select-track',
  'seek',
  'refresh',
  'start-login',
  'cancel-login',
  'logout',
  'load-custom',
]);

const customPlaylistId = ref('');
const lyricScroller = ref(null);
const activePanel = ref('queue');

const safeTime = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
const padTrack = (index) => String(index + 1).padStart(2, '0');

const coverSrc = computed(() => props.song?.cover || '/content/icon/32.png');
const safeCurrentTime = computed(() => safeTime(props.currentTime));
const safeDuration = computed(() => safeTime(props.duration));
const hasDuration = computed(() => safeDuration.value > 0);
const progressPercent = computed(() => (hasDuration.value ? Math.min(100, (safeCurrentTime.value / safeDuration.value) * 100) : 0));
const progressStyle = computed(() => ({ '--music-progress': `${progressPercent.value}%` }));
const hasPlayableSong = computed(() => Boolean(props.song?.url));
const playableCount = computed(() => props.playlist.filter((track) => track?.url).length);

const metaText = computed(() => {
  if (props.isLoading) return 'Loading playlist...';
  if (props.error) return `${props.error} · ${props.progressText}`;
  if (!props.song?.url) return `${props.song?.playError || 'No playable URL'} · ${props.progressText}`;
  return `${props.song?.artist || 'Unknown Artist'} · ${props.progressText}`;
});

const currentTrackLabel = computed(() => {
  if (!props.playlist.length) return '0 / 0';
  return `${Math.min(props.currentIndex + 1, props.playlist.length)} / ${props.playlist.length}`;
});

const artistText = computed(() => props.song?.artist || 'Unknown Artist');
const queueSummary = computed(() => (props.playlist.length ? `${props.playlist.length} 首` : '空列表'));
const panelTitle = computed(() => props.selectedPlaylistName || '音乐抽屉');
const playlistInputId = computed(() => `music-playlist-id-${props.instanceId}`);

const submitCustomPlaylist = () => {
  const id = customPlaylistId.value.trim();
  if (!id) return;
  emit('load-custom', id);
  customPlaylistId.value = '';
  activePanel.value = 'queue';
};

const seek = (event) => {
  const nextTime = Number(event.target.value);
  if (!Number.isFinite(nextTime)) return;
  emit('seek', nextTime);
};

const chooseTrack = (index, track) => {
  if (!track?.url) return;
  emit('select-track', index);
};

watch(
  () => props.isLoginOpen,
  (isOpen) => {
    if (isOpen) activePanel.value = 'source';
  },
);

watch(
  () => [props.activeLyricIndex, activePanel.value],
  async ([index]) => {
    if ((props.instanceId !== 'hero' && activePanel.value !== 'lyrics') || index < 0) return;
    await nextTick();
    lyricScroller.value?.querySelector(`[data-lyric-index="${index}"]`)?.scrollIntoView({
      block: 'center',
      behavior: 'smooth',
    });
  },
);
</script>

<template>
  <aside class="music-dock" :class="{ 'is-expanded': isLibraryOpen, 'is-playing': isPlaying }" aria-label="Music player">
    <div class="music-dock-main">
      <img class="music-cover" :class="{ 'is-playing': isPlaying }" :src="coverSrc" :alt="`${song.name} cover`" />

      <div class="music-now">
        <div class="music-title-row">
          <strong>{{ song.name }}</strong>
          <span>{{ currentTrackLabel }}</span>
        </div>
        <span class="music-subtitle">{{ metaText }}</span>
        <label class="music-progress" :style="progressStyle" aria-label="Track progress">
          <input
            type="range"
            min="0"
            :max="hasDuration ? safeDuration : 100"
            :value="safeCurrentTime"
            step="1"
            :disabled="!hasDuration"
            @input="seek"
          />
        </label>
      </div>

      <div class="music-actions">
        <button type="button" aria-label="Previous song" title="Previous" :disabled="!playableCount || isLoading" @click="$emit('previous')">
          <SkipBack :size="18" />
        </button>
        <button
          class="play-button"
          type="button"
          :aria-label="isPlaying ? 'Pause' : 'Play'"
          :title="isPlaying ? 'Pause' : 'Play'"
          :disabled="!hasPlayableSong || isLoading"
          @click="$emit('toggle')"
        >
          <Pause v-if="isPlaying" :size="20" />
          <Play v-else :size="20" />
        </button>
        <button type="button" aria-label="Next song" title="Next" :disabled="!playableCount || isLoading" @click="$emit('next')">
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

    <Teleport to="body" :disabled="instanceId !== 'hero'">
      <section v-if="isLibraryOpen && instanceId === 'hero'" class="music-panel music-panel--hero-sheet music-panel--hero-3col">
        <button class="music-sheet-close" type="button" aria-label="Close music library" title="Close" @click="$emit('toggle-library')">
          <X :size="18" />
        </button>

        <section class="hero-sheet-column hero-sheet-now" aria-label="Current song and playlists">
          <div class="hero-sheet-now-card">
            <img class="hero-sheet-cover" :src="coverSrc" :alt="`${song.name} cover`" />
            <div class="hero-sheet-current">
              <span>正在播放</span>
              <strong>{{ song.name }}</strong>
              <small>{{ artistText }}</small>
            </div>

            <label class="music-progress hero-sheet-progress" :style="progressStyle" aria-label="Track progress">
              <input
                type="range"
                min="0"
                :max="hasDuration ? safeDuration : 100"
                :value="safeCurrentTime"
                step="1"
                :disabled="!hasDuration"
                @input="seek"
              />
            </label>

            <div class="hero-sheet-controls">
              <button type="button" aria-label="Previous song" title="Previous" :disabled="!playableCount || isLoading" @click="$emit('previous')">
                <SkipBack :size="18" />
              </button>
              <button
                class="play-button"
                type="button"
                :aria-label="isPlaying ? 'Pause' : 'Play'"
                :title="isPlaying ? 'Pause' : 'Play'"
                :disabled="!hasPlayableSong || isLoading"
                @click="$emit('toggle')"
              >
                <Pause v-if="isPlaying" :size="20" />
                <Play v-else :size="20" />
              </button>
              <button type="button" aria-label="Next song" title="Next" :disabled="!playableCount || isLoading" @click="$emit('next')">
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
            </div>
          </div>

          <div class="hero-sheet-playlists">
            <div class="playlist-toolbar">
              <span>{{ selectedPlaylistName || '当前歌单' }}</span>
              <button type="button" class="text-button" :disabled="isLoading" @click="$emit('refresh')">
                <RefreshCw :size="15" /> 刷新
              </button>
            </div>

            <div class="playlist-switcher" aria-label="Playlist choices">
              <button
                v-for="item in playlists"
                :key="item.key"
                type="button"
                :class="{ active: item.key === selectedPlaylistKey }"
                :disabled="isLoading"
                @click="$emit('select-playlist', item.key)"
              >
                <span>{{ item.name }}</span>
              </button>
            </div>
          </div>
        </section>

        <section class="hero-sheet-column hero-sheet-tracks" aria-label="Track queue">
          <header class="music-panel-header">
            <div>
              <strong>歌曲列表</strong>
              <span>{{ queueSummary }}</span>
            </div>
          </header>

          <div class="queue-list">
            <button
              v-for="(track, index) in playlist"
              :key="`${track.id || track.name}-${index}`"
              type="button"
              class="queue-track"
              :class="{ active: index === currentIndex }"
              :disabled="isLoading || !track.url"
              @click="chooseTrack(index, track)"
            >
              <span class="queue-index">{{ padTrack(index) }}</span>
              <img class="queue-cover" :src="track.cover" :alt="`${track.name} cover`" />
              <span class="queue-meta">
                <strong>{{ track.name }}</strong>
                <small>{{ track.artist || 'Unknown Artist' }}</small>
              </span>
            </button>
          </div>
        </section>

        <section class="hero-sheet-column hero-sheet-side" aria-label="Lyrics and source">
          <header class="music-panel-header">
            <div>
              <strong>歌词</strong>
            </div>
          </header>

          <div ref="lyricScroller" class="music-panel-view lyric-box hero-sheet-lyrics" aria-label="Lyrics">
            <p v-if="!lyrics.length">暂无歌词</p>
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

          <div class="music-source-panel hero-sheet-login">
            <div class="music-login-row" :class="loginStatus">
              <div>
                <span v-if="isLoggedIn"><CheckCircle2 :size="16" /> 登录有效</span>
                <span v-else><QrCode :size="16" /> 扫码登录</span>
                <small v-if="loginMessage">{{ loginMessage }}</small>
              </div>
              <button v-if="isLoggedIn" type="button" class="text-button" @click="$emit('logout')">退出</button>
              <button v-else type="button" class="text-button" :disabled="isPollingLogin" @click="$emit('start-login')">
                <LogIn :size="15" /> {{ isPollingLogin ? '等待中' : '扫码' }}
              </button>
            </div>

            <div v-if="isLoginOpen" class="music-qr-box">
              <img v-if="qrImage" :src="qrImage" :alt="`Scan with ${scanApp || 'music app'}`" />
              <a v-else-if="qrUrl" :href="qrUrl" target="_blank" rel="noreferrer">打开登录二维码</a>
              <span v-else>正在生成二维码...</span>
              <button type="button" class="text-button" @click="$emit('cancel-login')">取消</button>
            </div>

            <form class="playlist-import" @submit.prevent="submitCustomPlaylist">
              <label :for="playlistInputId">歌单 ID</label>
              <div>
                <input :id="playlistInputId" v-model="customPlaylistId" placeholder="9206816111" inputmode="numeric" />
                <button type="submit">载入</button>
              </div>
            </form>
          </div>
        </section>
      </section>

      <section v-else-if="isLibraryOpen" class="music-panel">
        <div class="music-panel-left">
          <header class="music-panel-header">
            <div>
              <strong>{{ panelTitle }}</strong>
              <span>{{ queueSummary }}</span>
            </div>
            <button type="button" aria-label="Close music library" title="Close" @click="$emit('toggle-library')">
              <X :size="18" />
            </button>
          </header>

        <div class="playlist-toolbar">
          <span>{{ selectedPlaylistName || '当前歌单' }}</span>
          <button type="button" class="text-button" :disabled="isLoading" @click="$emit('refresh')">
            <RefreshCw :size="15" /> 刷新
          </button>
        </div>

        <div class="playlist-switcher" aria-label="Playlist choices">
          <button
            v-for="item in playlists"
            :key="item.key"
            type="button"
            :class="{ active: item.key === selectedPlaylistKey }"
            :disabled="isLoading"
            @click="$emit('select-playlist', item.key)"
          >
            <span>{{ item.name }}</span>
          </button>
        </div>

        <div class="queue-list" aria-label="Track queue">
          <button
            v-for="(track, index) in playlist"
            :key="`${track.id || track.name}-${index}`"
            type="button"
            class="queue-track"
            :class="{ active: index === currentIndex }"
            :disabled="isLoading || !track.url"
            @click="chooseTrack(index, track)"
          >
            <span class="queue-index">{{ padTrack(index) }}</span>
            <img class="queue-cover" :src="track.cover" :alt="`${track.name} cover`" />
            <span class="queue-meta">
              <strong>{{ track.name }}</strong>
              <small>{{ track.artist || 'Unknown Artist' }}</small>
            </span>
          </button>
        </div>
      </div>

      <div class="music-panel-right">
        <div class="music-panel-tabs" role="tablist" aria-label="Music panel sections">
          <button type="button" :class="{ active: activePanel === 'queue' }" role="tab" :aria-selected="activePanel === 'queue'" @click="activePanel = 'queue'">
            <Music2 :size="15" /> 播放
          </button>
          <button type="button" :class="{ active: activePanel === 'lyrics' }" role="tab" :aria-selected="activePanel === 'lyrics'" @click="activePanel = 'lyrics'">
            <ListMusic :size="15" /> 歌词
          </button>
          <button type="button" :class="{ active: activePanel === 'source' }" role="tab" :aria-selected="activePanel === 'source'" @click="activePanel = 'source'">
            <QrCode :size="15" /> 来源
          </button>
        </div>

        <div v-show="activePanel === 'queue'" class="music-panel-view now-panel">
          <img :src="coverSrc" :alt="`${song.name} cover`" />
          <div>
            <span>当前</span>
            <strong>{{ song.name }}</strong>
            <p>{{ artistText }}</p>
          </div>
        </div>

        <div v-show="activePanel === 'lyrics'" ref="lyricScroller" class="music-panel-view lyric-box" aria-label="Lyrics">
          <p v-if="!lyrics.length">暂无歌词</p>
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

        <div v-show="activePanel === 'source'" class="music-panel-view music-source-panel">
          <div class="music-login-row" :class="loginStatus">
            <div>
              <span v-if="isLoggedIn"><CheckCircle2 :size="16" /> 登录有效</span>
              <span v-else><QrCode :size="16" /> 扫码登录</span>
              <small v-if="loginMessage">{{ loginMessage }}</small>
            </div>
            <button v-if="isLoggedIn" type="button" class="text-button" @click="$emit('logout')">退出</button>
            <button v-else type="button" class="text-button" :disabled="isPollingLogin" @click="$emit('start-login')">
              <LogIn :size="15" /> {{ isPollingLogin ? '等待中' : '扫码' }}
            </button>
          </div>

          <div v-if="isLoginOpen" class="music-qr-box">
            <img v-if="qrImage" :src="qrImage" :alt="`Scan with ${scanApp || 'music app'}`" />
            <a v-else-if="qrUrl" :href="qrUrl" target="_blank" rel="noreferrer">打开登录二维码</a>
            <span v-else>正在生成二维码...</span>
            <button type="button" class="text-button" @click="$emit('cancel-login')">取消</button>
          </div>

          <form class="playlist-import" @submit.prevent="submitCustomPlaylist">
            <label :for="playlistInputId">歌单 ID</label>
            <div>
              <input :id="playlistInputId" v-model="customPlaylistId" placeholder="9206816111" inputmode="numeric" />
              <button type="submit">载入</button>
            </div>
          </form>
        </div>
        </div>
      </section>
    </Teleport>
  </aside>
</template>
