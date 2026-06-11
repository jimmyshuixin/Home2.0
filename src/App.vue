<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  ArrowRight,
  Camera,
  Code2,
  Dumbbell,
  Gamepad2,
  Github,
  ListMusic,
  Mail,
  MessageCircle,
  Music2,
  Pause,
  PenLine,
  Play,
  Repeat,
  Rocket,
  Send,
  Shuffle,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-vue-next';
import ChapterHeading from './components/ChapterHeading.vue';
import MusicDock from './components/MusicDock.vue';
import SiteHeader from './components/SiteHeader.vue';
import VideoModal from './components/VideoModal.vue';
import { useContact } from './composables/useContact';
import { useGithubData } from './composables/useGithubData';
import { useGuestbook } from './composables/useGuestbook';
import { useMusic } from './composables/useMusic';
import { useScrollState } from './composables/useScrollState';
import { useTheme } from './composables/useTheme';
import { navItems, resumeData, siteConfig } from './data/site';

const { isDark, toggleTheme } = useTheme();
const { progress, showBackToTop, activeSection, isNavHidden, scrollTo, scrollToTop } = useScrollState();
const { github, featuredRepos } = useGithubData();
const { guestbook, activeNotes, submitGuestbook } = useGuestbook();
const { contact, submitContact } = useContact();
const {
  activeLyricIndex,
  cancelQrLogin,
  currentSong,
  loadCustomPlaylist,
  logoutMusic,
  lyrics,
  musicState,
  nextSong,
  playlist,
  playlists,
  previousSong,
  progressText,
  refreshPlaylist,
  seekTo,
  selectTrack,
  startQrLogin,
  switchPlaylist,
  togglePlay,
  togglePlayMode,
} = useMusic();

const showVideoModal = ref(false);
const isDouyinOpen = ref(false);
const isDesktopViewport = ref(false);
const contactMode = ref('email');
const gameUid = '188938401';
const uidCopyStatus = ref('');
let uidCopyTimer;

const fitnessDayCount = computed(() => {
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const fitnessStartUtc = Date.UTC(2022, 9, 18);
  return Math.max(1, Math.floor((todayUtc - fitnessStartUtc) / 864e5) + 1);
});
const siteUptime = computed(() => Math.ceil(Math.abs(new Date() - new Date(siteConfig.siteStartDate)) / 864e5));
const currentDate = computed(() =>
  new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).format(new Date()),
);
const repoStats = computed(() => [
  { label: '提交贡献', value: github.stats.contributions || '326' },
  { label: '开源仓库', value: github.stats.repos || '21' },
  { label: '获得星标', value: github.stats.stars || '18' },
]);

const closeDouyin = () => {
  isDouyinOpen.value = false;
};

const copyGameUid = async () => {
  try {
    await navigator.clipboard.writeText(gameUid);
    uidCopyStatus.value = '已复制';
  } catch {
    uidCopyStatus.value = '复制失败';
  }
  window.clearTimeout(uidCopyTimer);
  uidCopyTimer = window.setTimeout(() => {
    uidCopyStatus.value = '';
  }, 1800);
};

let desktopMediaQuery;
const syncDesktopViewport = () => {
  isDesktopViewport.value = Boolean(desktopMediaQuery?.matches);
};

onMounted(() => {
  desktopMediaQuery = window.matchMedia('(min-width: 861px)');
  syncDesktopViewport();
  desktopMediaQuery.addEventListener('change', syncDesktopViewport);
  window.addEventListener('keydown', handleEscape);
});

onBeforeUnmount(() => {
  desktopMediaQuery?.removeEventListener('change', syncDesktopViewport);
  window.removeEventListener('keydown', handleEscape);
  window.clearTimeout(uidCopyTimer);
  document.body.style.overflow = '';
});

const handleEscape = (event) => {
  if (event.key === 'Escape') closeDouyin();
};

watch(isDouyinOpen, (open) => {
  document.body.style.overflow = open ? 'hidden' : '';
});

const heroQueue = computed(() => playlist.value);
const heroMusicPercent = computed(() => {
  const current = Number(musicState.currentTime || 0);
  const duration = Number(musicState.duration || 0);
  if (!Number.isFinite(current) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(100, Math.max(0, (current / duration) * 100));
});
const heroMusicStyle = computed(() => ({ '--hero-music-progress': `${heroMusicPercent.value}%` }));
const canControlMusic = computed(() => Boolean(currentSong.value?.url));

const heroLyricLines = computed(() => {
  if (lyrics.value.length) return lyrics.value;
  return [
    { time: 0, text: currentSong.value?.name || '音乐正在路上' },
    { time: 1, text: currentSong.value?.artist || '旋律会在这里慢慢浮现' },
    { time: 2, text: progressText.value || '等待歌词同步' },
  ];
});

const heroLyricIndex = computed(() => {
  if (!heroLyricLines.value.length) return 0;
  const index = activeLyricIndex.value >= 0 ? activeLyricIndex.value : 0;
  return Math.min(index, heroLyricLines.value.length - 1);
});

const heroLyricStyle = computed(() => ({
  transform: `translateY(-${Math.max(0, heroLyricIndex.value - 1) * 38}px)`,
}));

const musicDockProps = computed(() => ({
  song: currentSong.value,
  playlist: playlist.value,
  playlists: playlists.value,
  selectedPlaylistKey: musicState.selectedPlaylistKey,
  selectedPlaylistName: musicState.selectedPlaylistName,
  currentIndex: musicState.index,
  currentTime: musicState.currentTime,
  duration: musicState.duration,
  lyrics: lyrics.value,
  activeLyricIndex: activeLyricIndex.value,
  playMode: musicState.playMode,
  isPlaying: musicState.isPlaying,
  isLoading: musicState.isLoading,
  isLibraryOpen: musicState.isLibraryOpen,
  isLoggedIn: musicState.isLoggedIn,
  isLoginOpen: musicState.isLoginOpen,
  isPollingLogin: musicState.isPollingLogin,
  loginStatus: musicState.loginStatus,
  loginMessage: musicState.loginMessage,
  qrImage: musicState.qrImage,
  qrUrl: musicState.qrUrl,
  scanApp: musicState.scanApp,
  source: musicState.source,
  error: musicState.error,
  progressText: progressText.value,
}));

const musicDockEvents = {
  toggle: togglePlay,
  next: nextSong,
  previous: previousSong,
  'select-track': selectTrack,
  seek: seekTo,
  'toggle-mode': togglePlayMode,
  'toggle-library': () => {
    musicState.isLibraryOpen = !musicState.isLibraryOpen;
  },
  'select-playlist': switchPlaylist,
  refresh: refreshPlaylist,
  'start-login': startQrLogin,
  'cancel-login': cancelQrLogin,
  logout: logoutMusic,
  'load-custom': loadCustomPlaylist,
};
</script>

<template>
  <div class="app-shell" :style="{ '--scroll-progress': progress }">
    <SiteHeader
      :active-section="activeSection"
      :is-dark="isDark"
      :is-hidden="isNavHidden"
      @scroll-to="scrollTo"
      @toggle-theme="toggleTheme"
    />

    <Transition name="fade">
      <div v-if="isDouyinOpen" class="modal-backdrop douyin-modal-backdrop" @click.self="closeDouyin">
        <section class="douyin-modal" role="dialog" aria-modal="true" aria-labelledby="photography-douyin-title">
          <button class="icon-button modal-close" type="button" aria-label="关闭抖音二维码" @click="closeDouyin">
            <X :size="22" />
          </button>
          <p>扫码关注</p>
          <h2 id="photography-douyin-title">虚宁的抖音</h2>
          <img src="/content/social/douyin-qr.jpg" alt="虚宁的抖音二维码" />
          <span>抖音号：tidingjinluo</span>
        </section>
      </div>
    </Transition>

    <aside v-if="progress > 0.16" class="section-rail desktop-only" aria-label="章节快捷导航">
      <button
        v-for="item in navItems"
        :key="item.id"
        type="button"
        :class="{ active: activeSection === item.id }"
        @click="scrollTo(item.id)"
      >
        <span>{{ item.label }}</span>
      </button>
    </aside>

    <main class="site-main">
      <section id="hero" class="hero-section">
        <div class="hero-grid">
          <figure class="portrait-card">
            <div class="portrait-frame">
              <img src="/content/visuals/field-portrait.png" alt="虚宁手绘头像" />
            </div>
          </figure>

          <div class="hero-copy">
            <h1>
              <span>虚宁</span>
            </h1>
            <p class="hero-statement">
              路漫漫其修远兮，吾将上下而求索。
            </p>

            <div class="hero-actions" aria-label="首页主要操作">
              <button class="paper-button paper-button--primary" type="button" @click="scrollTo('recent')">
                开始阅读
                <ArrowRight :size="18" />
              </button>
              <button class="paper-button paper-button--ghost" type="button" @click="showVideoModal = true">
                <Camera :size="18" />
                年度摄影记录
              </button>
            </div>

            <p class="hero-focus-title">最近在做</p>
              <dl class="hero-focus-list hero-focus-list--notes">
              <div>
                <dt><Dumbbell :size="17" /> 健身</dt>
              </div>
              <div>
                <dt><Camera :size="17" /> 摄影</dt>
              </div>
            </dl>

            <div class="hero-danmaku-layer" aria-label="实时留言弹幕">
              <div
                v-for="note in activeNotes"
                :key="note.id"
                class="hero-danmaku-item"
                :style="note.style"
              >
                <span>{{ note.name }}</span>
                <p>{{ note.message }}</p>
              </div>
            </div>
          </div>

          <aside class="hero-console" aria-label="首页音乐与留言">
            <section class="hero-player-card" aria-label="首页音乐播放器">
              <header>
                <span><Music2 :size="16" /> 正在播放</span>
              </header>

              <div class="hero-player-now">
                <img :src="currentSong.cover || '/content/icon/32.png'" :alt="`${currentSong.name} cover`" />
                <div>
                  <strong>{{ currentSong.name }}</strong>
                  <span>{{ currentSong.artist || 'Unknown Artist' }}</span>
                  <p>{{ progressText }}</p>
                </div>
              </div>

              <label class="hero-player-progress" :style="heroMusicStyle" aria-label="Track progress">
                <input
                  type="range"
                  min="0"
                  :max="musicState.duration || 100"
                  :value="musicState.currentTime || 0"
                  step="1"
                  :disabled="!musicState.duration"
                  @input="seekTo(Number($event.target.value))"
                />
              </label>

              <div class="hero-player-controls">
                <button type="button" aria-label="Previous song" :disabled="!canControlMusic" @click="previousSong">
                  <SkipBack :size="20" />
                </button>
                <button class="hero-play-button" type="button" :aria-label="musicState.isPlaying ? 'Pause' : 'Play'" :disabled="!canControlMusic" @click="togglePlay">
                  <Pause v-if="musicState.isPlaying" :size="24" />
                  <Play v-else :size="24" />
                </button>
                <button type="button" aria-label="Next song" :disabled="!canControlMusic" @click="nextSong">
                  <SkipForward :size="20" />
                </button>
                <button type="button" :aria-label="musicState.playMode === 'random' ? 'Random playback enabled' : 'Ordered playback enabled'" @click="togglePlayMode">
                  <Shuffle v-if="musicState.playMode === 'random'" :size="20" />
                  <Repeat v-else :size="20" />
                </button>
              </div>

              <div class="hero-player-queue">
                <button
                  v-for="(track, index) in heroQueue"
                  :key="`${track.id || track.name}-${index}`"
                  type="button"
                  :class="{ active: index === musicState.index }"
                  :disabled="!track.url"
                  @click="selectTrack(index, track)"
                >
                  <span>{{ track.name }}</span>
                  <small>{{ track.artist || 'Unknown Artist' }}</small>
                </button>
              </div>
              <button class="hero-player-link" type="button" aria-label="打开音乐面板" title="打开音乐面板" @click="musicState.isLibraryOpen = true">
                <span>打开音乐面板</span>
                <ListMusic :size="19" />
              </button>
            </section>
          </aside>

        </div>
      </section>

      <section id="recent" class="journal-section recent-section">
        <ChapterHeading number="01" title="最近" />
        <div class="recent-layout">
          <article class="recent-card recent-card--fitness">
            <div class="recent-card__topline">
              <span>01 / FITNESS</span>
              <Dumbbell :size="22" aria-hidden="true" />
            </div>
            <div class="recent-fitness__copy">
              <p>健身</p>
              <span>累计坚持</span>
              <strong>{{ fitnessDayCount }}<small>天</small></strong>
              <time datetime="2022-10-18">始于 2022.10.18</time>
            </div>
            <div class="recent-fitness__track" aria-hidden="true">
              <span></span><span></span><span></span><span></span><span></span>
            </div>
            <img src="/content/recent/fitness-cover.png" alt="健身训练记录封面" />
          </article>

          <article class="recent-card recent-card--photography">
            <img src="/content/recent/photography-cover.jpg" alt="暖色灯光摄影作品" />
            <div class="recent-card__topline recent-card__topline--light">
              <span>02 / PHOTOGRAPHY</span>
              <Camera :size="22" aria-hidden="true" />
            </div>
            <div class="recent-photography__copy">
              <p>摄影</p>
              <strong>光隅</strong>
              <button class="recent-photography__douyin" type="button" @click="isDouyinOpen = true">前往抖音</button>
            </div>
          </article>

          <article class="recent-card recent-card--game">
            <div class="recent-card__topline">
              <span>03 / LEISURE</span>
              <Gamepad2 :size="22" aria-hidden="true" />
            </div>
            <div class="recent-game__copy">
              <p>娱乐</p>
              <strong>常玩游戏</strong>
              <button
                class="game-uid-copy"
                type="button"
                :aria-label="uidCopyStatus ? `${uidCopyStatus}，游戏 UID ${gameUid}` : `复制游戏 UID ${gameUid}`"
                @click="copyGameUid"
              >
                原神 · {{ uidCopyStatus || `加我好友：${gameUid}` }}
              </button>
            </div>
            <div class="recent-game__orbit" aria-hidden="true"></div>
            <img src="/content/game/Furina1.png" alt="原神角色芙宁娜" />
          </article>
        </div>

      </section>

      <section id="tech" class="journal-section">
        <ChapterHeading number="02" title="技术 & 创造" accent="blue" />
        <div class="tech-ledger">
          <article class="notebook-panel skill-table">
            <h3><Code2 :size="20" /> 技能栈</h3>
            <div v-for="group in resumeData.skills" :key="group.category" class="skill-row">
              <strong>{{ group.category }}</strong>
              <span>{{ group.items.join(' / ') }}</span>
            </div>
          </article>

          <article class="notebook-panel projects-list">
            <h3><Rocket :size="20" /> 项目精选</h3>
            <a v-for="project in resumeData.projects" :key="project.name" href="https://github.com/jimmyshuixin" target="_blank" rel="noreferrer">
              <div>
                <strong>{{ project.name }}</strong>
                <p>{{ project.result }}</p>
              </div>
              <time>{{ project.duration }}</time>
            </a>
          </article>

          <article class="notebook-panel github-panel">
            <h3><Github :size="20" /> 开源贡献</h3>
            <div class="github-heatmap" aria-label="GitHub contribution heatmap">
              <span v-for="n in 104" :key="n" :class="`level-${(n * 7) % 5}`"></span>
            </div>
            <div class="stats-row">
              <div v-for="stat in repoStats" :key="stat.label">
                <strong>{{ stat.value }}</strong>
                <span>{{ stat.label }}</span>
              </div>
            </div>
            <p v-if="github.error" class="status-line">{{ github.error }}</p>
          </article>

          <article class="notebook-panel repo-panel">
            <h3>置顶仓库</h3>
            <a v-for="repo in featuredRepos" :key="repo.name" :href="repo.link" target="_blank" rel="noreferrer" class="repo-row">
              <div>
                <strong>{{ repo.name }}</strong>
                <p>{{ repo.description }}</p>
              </div>
              <span>{{ repo.language }} · {{ repo.stars }}</span>
            </a>
            <a class="paper-button paper-button--small" :href="siteConfig.githubProfile" target="_blank" rel="noreferrer">
              去 Github 看更多项目 <ArrowRight :size="16" />
            </a>
          </article>
        </div>
      </section>

      <section id="contact" class="journal-section contact-section">
        <ChapterHeading number="03" title="留言 & 尾声" />
        <div class="contact-board">
          <article class="notebook-panel contact-panel">
            <div class="tabs" role="tablist" aria-label="联系模式">
              <button type="button" :class="{ active: contactMode === 'email' }" @click="contactMode = 'email'">
                <Mail :size="18" /> 写信给我
              </button>
              <button type="button" :class="{ active: contactMode === 'danmaku' }" @click="contactMode = 'danmaku'">
                <MessageCircle :size="18" /> 贴纸弹幕
              </button>
            </div>

            <form v-if="contactMode === 'email'" class="paper-form" @submit.prevent="submitContact">
              <label>
                <span>你的昵称</span>
                <input v-model="contact.name" autocomplete="name" placeholder="你的昵称 *" required />
              </label>
              <label>
                <span>邮箱 Address</span>
                <input v-model="contact.email" type="email" autocomplete="email" placeholder="邮箱 Address *" required />
              </label>
              <label>
                <span>想对我说的话</span>
                <textarea v-model="contact.message" maxlength="500" rows="6" placeholder="想对我说的话..." required></textarea>
              </label>
              <button class="paper-button paper-button--primary" type="submit" :disabled="contact.sending">
                <Send :size="18" /> {{ contact.sending ? '发送中...' : '发送信件' }}
              </button>
              <p v-if="contact.status" class="form-status" :class="contact.statusType">{{ contact.status }}</p>
            </form>

            <form v-else class="paper-form" @submit.prevent="submitGuestbook">
              <label>
                <span>你的昵称</span>
                <input v-model="guestbook.newName" maxlength="20" placeholder="你的昵称 *" required />
              </label>
              <label>
                <span>想贴上的纸条</span>
                <textarea v-model="guestbook.newMessage" maxlength="100" rows="5" placeholder="想贴上的纸条..." required></textarea>
              </label>
              <button class="paper-button paper-button--primary" type="submit" :disabled="guestbook.isSubmitting">
                <PenLine :size="18" /> {{ guestbook.isSubmitting ? '贴纸条中...' : '写下留言' }}
              </button>
              <p v-if="guestbook.status.message" class="form-status" :class="guestbook.status.type">
                {{ guestbook.status.message }}
              </p>
            </form>
          </article>

          <aside class="notebook-panel recent-notes">
            <h3>最近留言</h3>
            <div v-for="message in guestbook.messages.slice(0, 4)" :key="`${message.name}-${message.message}`" class="note-card">
              <strong>{{ message.name }}</strong>
              <span>{{ message.createdAt || '最近' }}</span>
              <p>{{ message.message }}</p>
            </div>
          </aside>

          <aside class="ai-card">
            <MessageCircle :size="26" />
            <strong>AI 助手</strong>
            <p>暂时安静地放在侧边，需要时再叫它出来。</p>
            <a href="/deepseek.html">去和我聊聊 <ArrowRight :size="16" /></a>
          </aside>
        </div>
      </section>
    </main>

    <footer class="site-footer">
      <div>
        <strong>虚宁</strong>
        <span>© 2022-{{ new Date().getFullYear() }} · 已运行 {{ siteUptime }} 天</span>
      </div>
      <nav aria-label="页脚导航">
        <button v-for="item in navItems" :key="item.id" type="button" @click="scrollTo(item.id)">
          {{ item.label }}
        </button>
      </nav>
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">{{ siteConfig.icpNumber }}</a>
    </footer>

    <MusicDock
      v-if="isDesktopViewport"
      class="music-dock--desktop-source"
      instance-id="hero"
      v-bind="musicDockProps"
      v-on="musicDockEvents"
    />

    <MusicDock
      class="music-dock--mobile mobile-only"
      instance-id="mobile"
      v-bind="musicDockProps"
      v-on="musicDockEvents"
    />

    <button class="back-to-top" :class="{ show: showBackToTop }" type="button" aria-label="回到顶部" @click="scrollToTop">
      ↑
    </button>

    <VideoModal :open="showVideoModal" @close="showVideoModal = false" />
  </div>
</template>
