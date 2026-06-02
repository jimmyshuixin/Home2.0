import undergraduateResume from '../../content/resume/undergraduate.json';
import masterResume from '../../content/resume/master.json';
import bookshelfSource from '../../content/bookshelf/bookshelf.json';
import growthSource from '../../content/growth.json';
import localPlaylistsSource from '../../content/music/local_playlists.json';
import musicSource from '../../content/music/music.json';

const withRootPath = (value) => (typeof value === 'string' ? value.replace(/^\.\//, '/') : value);

export const siteConfig = {
  name: '虚宁',
  englishName: "Xu Ning's Space",
  githubUser: 'jimmyshuixin',
  githubProfile: 'https://github.com/jimmyshuixin',
  bilibiliVideo:
    'https://player.bilibili.com/player.html?bvid=BV1b5ZpBsELe&page=1&high_quality=1&danmaku=0',
  githubApiUrl: 'https://github.xvyin.com/',
  guestbookApiUrl: 'https://firebase.xvyin.com/messages',
  emailApiUrl: 'https://email.xvyin.com',
  music: {
    apiUrl: import.meta.env.VITE_MUSIC_API_URL || 'https://music.xvyin.com/',
    server: import.meta.env.VITE_MUSIC_SERVER || 'tencent',
    type: import.meta.env.VITE_MUSIC_TYPE || 'playlist',
    playlistId: import.meta.env.VITE_MUSIC_PLAYLIST_ID || '9206816111',
    playlistName: import.meta.env.VITE_MUSIC_PLAYLIST_NAME || 'QQ Music Playlist',
    limit: Number(import.meta.env.VITE_MUSIC_LIMIT || 18),
    timeoutMs: Number(import.meta.env.VITE_MUSIC_TIMEOUT_MS || 8000),
    playlists: [
      {
        id: import.meta.env.VITE_MUSIC_PLAYLIST_ID || '9206816111',
        name: import.meta.env.VITE_MUSIC_PLAYLIST_NAME || 'QQ Music Playlist',
        server: import.meta.env.VITE_MUSIC_SERVER || 'tencent',
        type: import.meta.env.VITE_MUSIC_TYPE || 'playlist',
      },
    ],
    localPlaylists: localPlaylistsSource.map((playlist) => ({
      ...playlist,
      file: withRootPath(playlist.file),
    })),
  },
  siteStartDate: '2024-03-02',
  icpNumber: '渝ICP备2025053763号-1',
};

export const navItems = [
  { id: 'story', label: '故事', icon: 'Sparkles' },
  { id: 'growth', label: '轨迹', icon: 'Route' },
  { id: 'life', label: '生活', icon: 'Heart' },
  { id: 'tech', label: '技术', icon: 'Code2' },
  { id: 'future', label: '未来', icon: 'Rocket' },
  { id: 'contact', label: '留言', icon: 'MessagesSquare' },
];

export const resumeData = {
  name: '虚宁',
  location: undergraduateResume.location,
  education: [...masterResume.education, ...undergraduateResume.education],
  projects: undergraduateResume.projects,
  campusExperience: [
    { role: '科研项目', duration: '2026.09 - 未来', description: '即将开启新的研究旅程，继续在能源动力、数据分析与工程实践之间探索。' },
    ...undergraduateResume.campusExperience,
  ],
  skills: undergraduateResume.skills,
  honors: {
    graduate: masterResume.honors?.length ? masterResume.honors : ['更多精彩，敬请期待...'],
    undergraduate: undergraduateResume.honors,
  },
};

export const bookshelf = bookshelfSource.map((book) => ({
  ...book,
  coverUrl: withRootPath(book.coverUrl),
}));

export const fallbackMusicList = musicSource.map((song) => ({
  ...song,
  url: withRootPath(song.url),
  cover: withRootPath(song.cover),
}));

export const growthData = growthSource;

export const plansData = [
  {
    title: '博士阶段研究',
    icon: 'Atom',
    desc: '围绕高能物理、数据分析与模拟优化继续深挖。',
    status: 'ing',
    progress: 75,
    milestones: [
      { label: '完成近期模拟任务', done: true },
      { label: '整理一篇技术博客', done: true },
      { label: '参与相关实验专题研究', done: false },
    ],
  },
  {
    title: '开源项目迭代',
    icon: 'GitBranch',
    desc: '把个人网站从展示页升级为可持续维护的数字手账。',
    status: 'ing',
    progress: 60,
    milestones: [
      { label: '完成 Ver 3.0 UI 重构', done: false },
      { label: '整理组件与部署文档', done: false },
      { label: '持续记录与维护', done: false },
    ],
  },
  {
    title: '健身',
    icon: 'HeartPulse',
    desc: '身体健康，便是热爱。',
    status: 'done',
    progress: 99,
    milestones: [
      { label: '标准 10 个引体', done: true },
      { label: '标准 30 个俯卧撑', done: true },
      { label: '标准俄挺 5s', done: false },
    ],
  },
  {
    title: '星空摄影',
    icon: 'Camera',
    desc: '有朝一日，希望与银河同框。',
    status: 'planning',
    progress: 20,
    milestones: [
      { label: '地点选取', done: true },
      { label: '摄影学习', done: false },
      { label: '拍摄与后期处理', done: false },
    ],
  },
  {
    title: '学习竹笛',
    icon: 'Music2',
    desc: '我喜欢纯音乐，也想亲手吹出一段旋律。',
    status: 'planning',
    progress: 10,
    milestones: [{ label: '音阶练习', done: false }],
  },
];

export const socialLinks = [
  { label: 'GitHub', value: 'github.com/jimmyshuixin', href: 'https://github.com/jimmyshuixin' },
  { label: 'Bilibili', value: '年度摄影记录', href: 'https://www.bilibili.com/video/BV1b5ZpBsELe' },
  { label: 'Douyin', value: 'tidingjinluo', href: 'https://www.douyin.com/search/tidingjinluo' },
];

export const fallbackRepos = [
  {
    name: 'Home',
    description: '一份持续迭代的个人主页与数字手账。',
    language: 'Vue',
    stars: 0,
    link: siteConfig.githubProfile,
  },
  {
    name: 'AQI Forecast',
    description: '基于 LSTM/Transformer 的空气质量预测与展示系统。',
    language: 'Python',
    stars: 0,
    link: siteConfig.githubProfile,
  },
];
