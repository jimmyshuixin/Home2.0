import undergraduateResume from '../../content/resume/undergraduate.json';
import localPlaylistsSource from '../../content/music/local_playlists.json';
import musicSource from '../../content/music/music.json';

const withRootPath = (value) => (typeof value === 'string' ? value.replace(/^\.\//, '/') : value);
const readMusicLimit = (value) => {
  const raw = String(value || 'all').trim();
  if (!raw || raw.toLowerCase() === 'all') return 'all';
  const limit = Number.parseInt(raw, 10);
  return Number.isFinite(limit) && limit > 0 ? limit : 'all';
};

export const siteConfig = {
  name: '虚宁',
  englishName: 'Xu Ning',
  githubUser: 'jimmyshuixin',
  githubProfile: 'https://github.com/jimmyshuixin',
  bilibiliVideo:
    'https://player.bilibili.com/player.html?bvid=BV1b5ZpBsELe&page=1&high_quality=1&danmaku=0&autoplay=1',
  githubApiUrl: 'https://github.xvyin.com/',
  guestbookApiUrl: 'https://firebase.xvyin.com/messages',
  emailApiUrl: 'https://email.xvyin.com',
  music: {
    apiUrl: import.meta.env.VITE_MUSIC_API_URL || 'https://music.xvyin.com/',
    server: import.meta.env.VITE_MUSIC_SERVER || 'tencent',
    type: import.meta.env.VITE_MUSIC_TYPE || 'playlist',
    playlistId: import.meta.env.VITE_MUSIC_PLAYLIST_ID || '9206816111',
    playlistName: import.meta.env.VITE_MUSIC_PLAYLIST_NAME || 'QQ Music Playlist',
    limit: readMusicLimit(import.meta.env.VITE_MUSIC_LIMIT),
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
  { id: 'recent', label: '最近', icon: 'Sparkles' },
  { id: 'tech', label: '技术', icon: 'Code2' },
  { id: 'contact', label: '留言', icon: 'MessagesSquare' },
];

export const resumeData = {
  projects: undergraduateResume.projects,
  skills: undergraduateResume.skills.filter((group) => group.category !== '办公软件'),
};

export const fallbackMusicList = musicSource.map((song) => ({
  ...song,
  url: withRootPath(song.url),
  cover: withRootPath(song.cover),
}));

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
