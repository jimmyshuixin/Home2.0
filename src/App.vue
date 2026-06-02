<script setup>
import { computed, ref } from 'vue';
import {
  ArrowRight,
  Atom,
  BookOpen,
  Camera,
  CheckCircle2,
  Code2,
  Dumbbell,
  ExternalLink,
  GitBranch,
  Github,
  Heart,
  HeartPulse,
  Mail,
  MapPin,
  MessageCircle,
  Music2,
  PenLine,
  Plane,
  Rocket,
  Send,
  Sparkles,
  Star,
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
import { bookshelf, growthData, navItems, plansData, resumeData, siteConfig, socialLinks } from './data/site';

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
  startQrLogin,
  switchPlaylist,
  togglePlay,
  togglePlayMode,
} = useMusic();

const showVideoModal = ref(false);
const contactMode = ref('email');
const currentBookIndex = ref(0);

const currentBook = computed(() => bookshelf[currentBookIndex.value] || bookshelf[0]);
const shelfBooks = computed(() => bookshelf.filter((_, index) => index !== currentBookIndex.value));
const fitnessDayCount = computed(() => Math.ceil(Math.abs(new Date() - new Date('2022-11-21')) / 864e5));
const siteUptime = computed(() => Math.ceil(Math.abs(new Date() - new Date(siteConfig.siteStartDate)) / 864e5));
const currentDate = computed(() =>
  new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).format(new Date()),
);
const plansInProgress = computed(() => plansData.filter((plan) => plan.status === 'ing' || plan.status === 'done'));
const plansPlanning = computed(() => plansData.filter((plan) => plan.status === 'planning'));

const planIcons = { Atom, Camera, GitBranch, HeartPulse, Music2 };
const statusLabels = { planning: '筹备中', ing: '进行中', done: '已达成' };

const switchBook = (book) => {
  currentBookIndex.value = bookshelf.findIndex((item) => item.title === book.title);
};

const repoStats = computed(() => [
  { label: '提交贡献', value: github.stats.contributions || '326' },
  { label: '开源仓库', value: github.stats.repos || '21' },
  { label: '获得星标', value: github.stats.stars || '18' },
]);
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

    <main>
      <section id="hero" class="hero-section">
        <div class="hero-notes" aria-hidden="true">
          <div v-for="note in activeNotes" :key="note.id" class="floating-note" :style="note.style">
            <strong>{{ note.name }}</strong>
            <span>{{ note.message }}</span>
          </div>
        </div>

        <div class="mobile-hero-card">
          <h1>虚宁</h1>
          <p>Xu Ning's Space</p>
          <div class="mobile-photo-note">
            <img src="/content/visuals/field-portrait.png" alt="虚宁手绘头像" />
            <blockquote>在探索中学习，在热爱中创造，于未来成为更好的自己。</blockquote>
          </div>
          <div class="mobile-current">
            <strong>最近在做</strong>
            <span><Atom :size="16" /> 研究：核科学与技术 & 加速器物理</span>
            <span><Code2 :size="16" /> 学习：AI & 全栈开发</span>
            <span><Heart :size="16" /> 生活：健身 · 阅读 · 摄影 · 音乐</span>
            <span><Rocket :size="16" /> 目标：持续成长，未来可期</span>
          </div>
        </div>

        <div class="portrait-card">
          <img src="/content/visuals/field-portrait.png" alt="虚宁手绘头像" />
          <p>Keep Exploring.</p>
        </div>

        <div class="hero-copy">
          <h1>Hi! I'm <span>虚宁</span></h1>
          <p class="hero-quote">路漫漫其修远兮<br />吾将上下而求索</p>
          <div class="hero-actions">
            <button class="paper-button paper-button--red" type="button" @click="showVideoModal = true">
              <Camera :size="20" />
              年度摄影记录
            </button>
            <button class="paper-button" type="button" @click="scrollTo('story')">
              <Sparkles :size="20" />
              双鱼座 / INFJ-A
            </button>
          </div>
        </div>

        <div class="hero-botanical" aria-hidden="true">
          <span></span><span></span><span></span><span></span>
        </div>

        <aside class="today-card">
          <span>{{ currentDate }}</span>
          <strong>晴 · 继续记录</strong>
        </aside>

        <div class="scroll-cue" @click="scrollTo('story')">
          <span>下滑翻阅</span>
          <ArrowRight :size="18" />
        </div>
      </section>

      <section id="story" class="journal-section story-section">
        <div class="torn-edge torn-edge--top" aria-hidden="true"></div>
        <ChapterHeading number="01" title="故事 & 扉页" subtitle="这里是我的数字手账，一本关于成长、探索与热爱的记录。" />
        <div class="story-spread">
          <div>
            <p class="lead">
              这里是我的数字手账，一本关于成长、探索与热爱的记录。<br />
              我喜欢把复杂的问题拆开，也喜欢在生活里寻找微小的光。<br />
              工程与理性是我的底色，而好奇与热爱，让一切变得有意义。
            </p>
            <div class="interest-row">
              <span><Atom :size="18" /> 理性思考</span>
              <span><BookOpen :size="18" /> 持续学习</span>
              <span><Camera :size="18" /> 记录生活</span>
              <span><Rocket :size="18" /> 探索未知</span>
            </div>
          </div>
          <div class="open-book-illustration" aria-hidden="true">
            <div class="book-page">
              <strong>Stay curious.</strong>
              <span>Keep exploring.</span>
            </div>
            <div class="book-page book-page--image">
              <img src="/content/Photos/1.jpg" alt="" />
            </div>
          </div>
        </div>
        <div class="volume-divider">
          <div class="compass-doodle" aria-hidden="true"></div>
          <span>Volume.1</span>
          <strong>探索与求索</strong>
          <small>从好奇出发，沿着问题的轨迹，一步一步向前。</small>
        </div>
      </section>

      <section id="growth" class="journal-section">
        <ChapterHeading number="02" title="成长 & 轨迹" subtitle="在探索中学习，在实践中成长。" accent="yellow" />
        <div class="notebook-grid notebook-grid--growth">
          <article class="notebook-panel timeline-panel">
            <h3><MapPin :size="20" /> 教育背景</h3>
            <ol class="timeline">
              <li v-for="edu in resumeData.education" :key="`${edu.institution}-${edu.duration}`">
                <time>{{ edu.duration }}</time>
                <strong>{{ edu.institution }}</strong>
                <span>{{ edu.major }}<template v-if="edu.minor"> / {{ edu.minor }}</template></span>
                <small v-if="edu.gpa">GPA {{ edu.gpa }} · Rank {{ edu.ranking }}</small>
              </li>
            </ol>
          </article>

          <article class="notebook-panel honors-panel">
            <h3><Star :size="20" /> 荣誉墙</h3>
            <div class="honor-stage">
              <strong>研究生阶段</strong>
              <span v-for="item in resumeData.honors.graduate" :key="item">{{ item }}</span>
            </div>
            <div class="honor-list">
              <span v-for="honor in resumeData.honors.undergraduate.slice(0, 4)" :key="honor">
                {{ honor }}
              </span>
            </div>
          </article>

          <article class="notebook-panel experience-panel">
            <h3><Plane :size="20" /> 校园历练</h3>
            <div class="experience-line">
              <div v-for="experience in resumeData.campusExperience" :key="experience.role">
                <strong>{{ experience.role }}</strong>
                <time>{{ experience.duration }}</time>
                <p>{{ experience.description }}</p>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section id="life" class="journal-section">
        <ChapterHeading number="03" title="活力 & 生活" subtitle="在热爱里充电，在生活中平衡。" accent="green" />
        <div class="life-board">
          <article class="notebook-panel fitness-panel">
            <div class="panel-topline">
              <h3><Dumbbell :size="20" /> 运动律动</h3>
              <span>累计活动天数</span>
            </div>
            <strong class="big-number">{{ fitnessDayCount }}<small>天</small></strong>
            <div class="sketch-chart" aria-label="近期训练强度图">
              <svg viewBox="0 0 420 110" role="img">
                <polyline
                  points="0,82 35,74 62,40 90,88 130,65 155,22 190,86 230,75 260,47 292,76 330,28 360,84 420,58"
                />
              </svg>
            </div>
            <div class="target-strip">
              <span>本月目标</span>
              <div><i style="width: 72%"></i></div>
              <strong>15 / 20</strong>
            </div>
          </article>

          <article class="notebook-panel bookshelf-panel">
            <h3><BookOpen :size="20" /> 书架藏书</h3>
            <div class="current-book">
              <img :src="currentBook.coverUrl" :alt="currentBook.title" />
              <div>
                <span>当前在读</span>
                <strong>{{ currentBook.title }}</strong>
                <p>{{ currentBook.author }}</p>
                <div class="stars">
                  <Star v-for="n in currentBook.rating" :key="n" :size="15" fill="currentColor" />
                </div>
              </div>
            </div>
            <div class="book-strip">
              <button v-for="book in shelfBooks" :key="book.title" type="button" @click="switchBook(book)">
                <img :src="book.coverUrl" :alt="book.title" />
              </button>
            </div>
          </article>

          <article class="notebook-panel media-panel">
            <h3><Camera :size="20" /> 影像记录</h3>
            <div class="photo-strip">
              <img src="/content/Photos/1.jpg" alt="摄影作品 1" />
              <img src="/content/Photos/2.jpg" alt="摄影作品 2" />
              <img src="/content/Photos/3.jpg" alt="摄影作品 3" />
            </div>
            <button class="text-link" type="button" @click="showVideoModal = true">
              查看年度摄影 <ArrowRight :size="16" />
            </button>
          </article>

          <article class="notebook-panel links-panel">
            <h3><Heart :size="20" /> 社交连接</h3>
            <a v-for="link in socialLinks" :key="link.label" :href="link.href" target="_blank" rel="noreferrer">
              <span>{{ link.label }}</span>
              <strong>{{ link.value }}</strong>
              <ExternalLink :size="16" />
            </a>
          </article>
        </div>
      </section>

      <section id="tech" class="journal-section">
        <ChapterHeading number="03" title="技术 & 创造" subtitle="点亮技能树，用代码与工程丈量世界。" accent="blue" />
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

      <section id="future" class="journal-section">
        <ChapterHeading number="04" title="未来 & 蓝图" subtitle="承载着未完成的梦想，也期待继续向前。" accent="yellow" />
        <div class="plans-board">
          <article class="notebook-panel">
            <h3>进行中 / 已达成</h3>
            <div v-for="plan in plansInProgress" :key="plan.title" class="plan-row">
              <component :is="planIcons[plan.icon] || Rocket" :size="22" />
              <div>
                <div class="plan-title">
                  <strong>{{ plan.title }}</strong>
                  <span :class="`status-${plan.status}`">{{ statusLabels[plan.status] }}</span>
                </div>
                <p>{{ plan.desc }}</p>
                <div class="progress-bar"><i :style="{ width: `${plan.progress}%` }"></i></div>
              </div>
              <b>{{ plan.progress }}%</b>
            </div>
          </article>

          <article class="notebook-panel plan-notes">
            <h3>筹备中</h3>
            <div v-for="plan in plansPlanning" :key="plan.title" class="todo-note">
              <strong>{{ plan.title }}</strong>
              <p>{{ plan.desc }}</p>
              <span v-for="milestone in plan.milestones" :key="milestone.label">
                <CheckCircle2 :size="15" :class="{ done: milestone.done }" />
                {{ milestone.label }}
              </span>
            </div>
          </article>

          <aside class="notebook-panel short-goals">
            <h3>短期小目标</h3>
            <label v-for="target in growthData.targets" :key="target.name">
              <input type="checkbox" :checked="target.current >= target.total" readonly />
              <span>{{ target.name }}</span>
            </label>
          </aside>
        </div>
      </section>

      <section id="contact" class="journal-section contact-section">
        <ChapterHeading number="05" title="留言 & 尾声" subtitle="感谢你的到来，欢迎留下你的足迹与想法。" />
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
              <button class="paper-button paper-button--dark" type="submit" :disabled="contact.sending">
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
                <span>邮箱（可选）</span>
                <input v-model="guestbook.newEmail" type="email" placeholder="邮箱（可选）" />
              </label>
              <label>
                <span>想贴上的纸条</span>
                <textarea v-model="guestbook.newMessage" maxlength="100" rows="5" placeholder="想贴上的纸条..." required></textarea>
              </label>
              <button class="paper-button paper-button--red" type="submit" :disabled="guestbook.isSubmitting">
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
        <strong>虚宁 | {{ siteConfig.englishName }}</strong>
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
      :song="currentSong"
      :playlist="playlist"
      :playlists="playlists"
      :selected-playlist-key="musicState.selectedPlaylistKey"
      :lyrics="lyrics"
      :active-lyric-index="activeLyricIndex"
      :play-mode="musicState.playMode"
      :is-playing="musicState.isPlaying"
      :is-loading="musicState.isLoading"
      :is-library-open="musicState.isLibraryOpen"
      :is-logged-in="musicState.isLoggedIn"
      :is-login-open="musicState.isLoginOpen"
      :is-polling-login="musicState.isPollingLogin"
      :login-status="musicState.loginStatus"
      :login-message="musicState.loginMessage"
      :qr-image="musicState.qrImage"
      :qr-url="musicState.qrUrl"
      :scan-app="musicState.scanApp"
      :source="musicState.source"
      :error="musicState.error"
      :progress-text="progressText"
      @toggle="togglePlay"
      @next="nextSong"
      @previous="previousSong"
      @toggle-mode="togglePlayMode"
      @toggle-library="musicState.isLibraryOpen = !musicState.isLibraryOpen"
      @select-playlist="switchPlaylist"
      @refresh="refreshPlaylist"
      @start-login="startQrLogin"
      @cancel-login="cancelQrLogin"
      @logout="logoutMusic"
      @load-custom="loadCustomPlaylist"
    />

    <button class="back-to-top" :class="{ show: showBackToTop }" type="button" aria-label="回到顶部" @click="scrollToTop">
      ↑
    </button>

    <VideoModal :open="showVideoModal" @close="showVideoModal = false" />
  </div>
</template>
