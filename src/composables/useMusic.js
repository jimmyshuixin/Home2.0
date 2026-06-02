import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { fallbackMusicList, siteConfig } from '../data/site';

const PLAY_MODE_KEY = 'home-music-play-mode';
const PLAYLIST_KEY = 'home-music-selected-playlist';
const SESSION_KEY = 'home-music-session';
const PLAYLIST_CACHE_PREFIX = 'home-music-playlist:';
const LOGIN_SUCCESS_CODE = 803;
const LOGIN_EXPIRED_CODE = 800;
const LOGIN_POLL_MS = 2400;

const normalizePath = (value) => {
  if (typeof value !== 'string') return '';
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  return value.replace(/^\.\//, '/');
};

const normalizeSong = (song = {}) => {
  const artist = Array.isArray(song.artist) ? song.artist.join(' / ') : song.artist || song.author || 'Unknown Artist';
  const url = normalizePath(song.url || song.src || song.link);

  return {
    id: song.id || song.url_id || song.mid || song.name || '',
    name: song.name || song.title || song.songname || 'Unknown Track',
    artist,
    album: song.album || '',
    source: song.source || '',
    url,
    playable: 'playable' in song ? Boolean(song.playable) : Boolean(url),
    playError: song.playError || song.message || '',
    cover: normalizePath(song.cover || song.pic || song.picture || song.image) || '/content/icon/32.png',
    lrc: song.lrc || song.lyric || '',
  };
};

const normalizePlaylist = (list) => (Array.isArray(list) ? list.map(normalizeSong).filter((song) => song.id || song.name) : []);

const safeJsonParse = (value, fallback = null) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const remotePlaylistOptions = siteConfig.music.playlists.map((playlist) => ({
  key: `${playlist.server || siteConfig.music.server}:${playlist.type || siteConfig.music.type}:${playlist.id}`,
  id: playlist.id,
  name: playlist.name || `${playlist.server || siteConfig.music.server} ${playlist.id}`,
  server: playlist.server || siteConfig.music.server,
  type: playlist.type || siteConfig.music.type,
  source: 'api',
}));

const localPlaylistOptions = siteConfig.music.localPlaylists.map((playlist) => ({
  key: playlist.id,
  id: playlist.id,
  name: playlist.name,
  file: playlist.file,
  source: 'local',
}));

const defaultPlaylist = remotePlaylistOptions[0] || {
  key: `${siteConfig.music.server}:${siteConfig.music.type}:${siteConfig.music.playlistId}`,
  id: siteConfig.music.playlistId,
  name: siteConfig.music.playlistName,
  server: siteConfig.music.server,
  type: siteConfig.music.type,
  source: 'api',
};

const playlistOptions = [defaultPlaylist, ...remotePlaylistOptions.slice(1), ...localPlaylistOptions];

const readCachedPlaylist = (cacheKey) => {
  try {
    const cached = safeJsonParse(sessionStorage.getItem(`${PLAYLIST_CACHE_PREFIX}${cacheKey}`));
    if (!cached || Date.now() > cached.expiresAt) return null;
    return normalizePlaylist(cached.items);
  } catch {
    return null;
  }
};

const cachePlaylist = (cacheKey, items) => {
  try {
    sessionStorage.setItem(
      `${PLAYLIST_CACHE_PREFIX}${cacheKey}`,
      JSON.stringify({ items, expiresAt: Date.now() + 1000 * 60 * 12 }),
    );
  } catch {
    // Storage can be unavailable in private browsing; playback should still work.
  }
};

const parseLyrics = (lrc = '') => {
  const lines = String(lrc)
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?]\s*(.*)$/);
      if (!match) return null;

      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = Number((match[3] || '0').padEnd(3, '0').slice(0, 3));
      const text = match[4]?.trim();

      if (!text) return null;
      return {
        time: minutes * 60 + seconds + fraction / 1000,
        text,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);

  return lines;
};

export function useMusic() {
  const audio = ref(null);
  const pollTimer = ref(null);
  const playlist = ref(fallbackMusicList.map(normalizeSong));
  const playlists = ref(playlistOptions);

  const state = reactive({
    index: 0,
    selectedPlaylistKey: defaultPlaylist.key,
    selectedPlaylistName: defaultPlaylist.name,
    playMode: 'order',
    isPlaying: false,
    isLoading: false,
    isLibraryOpen: false,
    currentTime: 0,
    duration: 0,
    source: 'local',
    error: '',
    sessionToken: '',
    sessionExpiresAt: '',
    isLoggedIn: false,
    isLoginOpen: false,
    isPollingLogin: false,
    loginStatus: 'idle',
    loginMessage: '',
    loginState: '',
    loginKey: '',
    loginServer: siteConfig.music.server,
    qrImage: '',
    qrUrl: '',
    scanApp: '',
  });

  const selectedPlaylist = computed(
    () => playlists.value.find((playlistItem) => playlistItem.key === state.selectedPlaylistKey) || playlists.value[0],
  );
  const currentSong = computed(() => playlist.value[state.index] || playlist.value[0] || normalizeSong());
  const lyrics = computed(() => parseLyrics(currentSong.value.lrc));
  const activeLyricIndex = computed(() => {
    if (!lyrics.value.length) return -1;

    for (let index = lyrics.value.length - 1; index >= 0; index -= 1) {
      if (state.currentTime + 0.15 >= lyrics.value[index].time) return index;
    }

    return 0;
  });

  const buildMusicApiUrl = (playlistItem = selectedPlaylist.value) => {
    if (!siteConfig.music.apiUrl || !playlistItem?.id) return '';

    try {
      const url = new URL(siteConfig.music.apiUrl, window.location.origin);
      url.searchParams.set('server', playlistItem.server || siteConfig.music.server);
      url.searchParams.set('type', playlistItem.type || siteConfig.music.type);
      url.searchParams.set('id', playlistItem.id);
      url.searchParams.set('limit', String(siteConfig.music.limit || 18));
      url.searchParams.set('lyric', '1');
      return url.toString();
    } catch {
      return '';
    }
  };

  const buildMusicEndpoint = (path, params = {}) => {
    const url = new URL(path, siteConfig.music.apiUrl || window.location.origin);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    });
    return url.toString();
  };

  const fetchJson = async (url, options = {}) => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), siteConfig.music.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...(state.sessionToken ? { Authorization: `Bearer ${state.sessionToken}` } : {}),
          ...(options.headers || {}),
        },
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || data?.message || `Music API request failed: ${response.status}`);
      }

      return data;
    } finally {
      window.clearTimeout(timeoutId);
    }
  };

  const getPlayableIndexes = () => playlist.value
    .map((song, index) => (song.url ? index : -1))
    .filter((index) => index >= 0);

  const getNextIndex = (direction = 1) => {
    const playableIndexes = getPlayableIndexes();
    if (!playableIndexes.length) return state.index;

    if (state.playMode === 'random' && playableIndexes.length > 1) {
      let nextIndex = state.index;
      while (nextIndex === state.index) {
        nextIndex = playableIndexes[Math.floor(Math.random() * playableIndexes.length)];
      }
      return nextIndex;
    }

    const currentPosition = playableIndexes.indexOf(state.index);
    if (currentPosition < 0) return playableIndexes[0];

    return playableIndexes[(currentPosition + direction + playableIndexes.length) % playableIndexes.length];
  };

  const setAudioSource = async (shouldPlay = state.isPlaying) => {
    if (!currentSong.value.url) {
      const nextPlayableIndex = getNextIndex(1);
      if (playlist.value[nextPlayableIndex]?.url) {
        state.index = nextPlayableIndex;
      } else {
        state.isPlaying = false;
        state.error = currentSong.value.playError || 'This playlist loaded, but no playable URLs were returned.';
        return;
      }
    }

    const player = ensureAudio();
    if (!player || !currentSong.value.url) return;

    const desiredUrl = new URL(currentSong.value.url, window.location.href).href;
    if (player.src !== desiredUrl) {
      player.src = desiredUrl;
      state.currentTime = 0;
      state.duration = 0;
    }

    if (shouldPlay) {
      try {
        await player.play();
        state.isPlaying = true;
      } catch {
        state.isPlaying = false;
      }
    }
  };

  const applyPlaylist = async (items, source = 'api', shouldAutoplay = state.isPlaying) => {
    const normalized = normalizePlaylist(items);
    if (!normalized.length) return false;
    const playableCount = normalized.filter((song) => song.url).length;

    playlist.value = normalized;
    state.index = 0;
    state.source = source;
    state.error = playableCount ? '' : 'Playlist loaded, but no playable URLs were returned. Try QR login or another playlist.';
    await setAudioSource(shouldAutoplay);
    return true;
  };

  const fallbackToLocal = async (message) => {
    await applyPlaylist(fallbackMusicList.map(normalizeSong), 'local', false);
    state.error = message;
  };

  const loadPlaylistFromApi = async (playlistItem = selectedPlaylist.value, { force = false } = {}) => {
    const apiUrl = buildMusicApiUrl(playlistItem);
    if (!apiUrl) return false;

    const cacheKey = `${playlistItem.key}:${state.sessionToken ? 'auth' : 'public'}`;
    if (!force && !state.sessionToken) {
      const cached = readCachedPlaylist(cacheKey);
      if (cached?.length && (await applyPlaylist(cached, 'api-cache', false))) return true;
    }

    state.isLoading = true;
    state.error = '';

    try {
      const data = await fetchJson(apiUrl);
      if (!(await applyPlaylist(data, 'api'))) throw new Error('Music API returned an empty playlist.');
      if (!state.sessionToken) cachePlaylist(cacheKey, data);
      return true;
    } catch (error) {
      await fallbackToLocal(
        error?.name === 'AbortError'
          ? 'Music API timed out. Switched to the local playlist.'
          : 'Music API is unavailable. Switched to the local playlist.',
      );
      return false;
    } finally {
      state.isLoading = false;
    }
  };

  const loadLocalPlaylist = async (playlistItem, shouldAutoplay = state.isPlaying) => {
    if (!playlistItem?.file) return false;

    state.isLoading = true;
    state.error = '';

    try {
      const data = await fetchJson(playlistItem.file, { headers: {} });
      return await applyPlaylist(data, 'local', shouldAutoplay);
    } catch {
      await fallbackToLocal('Local playlist could not be loaded. Switched to the default local songs.');
      return false;
    } finally {
      state.isLoading = false;
    }
  };

  const switchPlaylist = async (playlistKey, { force = false } = {}) => {
    const nextPlaylist = playlists.value.find((item) => item.key === playlistKey);
    if (!nextPlaylist || state.isLoading) return false;

    state.selectedPlaylistKey = nextPlaylist.key;
    state.selectedPlaylistName = nextPlaylist.name;

    try {
      localStorage.setItem(PLAYLIST_KEY, nextPlaylist.key);
    } catch {
      // Ignore storage failures.
    }

    if (nextPlaylist.source === 'local') {
      return await loadLocalPlaylist(nextPlaylist);
    }

    return await loadPlaylistFromApi(nextPlaylist, { force });
  };

  const loadCustomPlaylist = async (playlistId) => {
    const id = String(playlistId || '').trim();
    if (!id) return false;

    const customPlaylist = {
      key: `${siteConfig.music.server}:playlist:${id}`,
      id,
      name: `Playlist ${id}`,
      server: siteConfig.music.server,
      type: 'playlist',
      source: 'api',
    };

    const existingIndex = playlists.value.findIndex((item) => item.key === customPlaylist.key);
    if (existingIndex >= 0) {
      playlists.value.splice(existingIndex, 1, customPlaylist);
    } else {
      playlists.value.unshift(customPlaylist);
    }

    return await switchPlaylist(customPlaylist.key, { force: true });
  };

  const refreshPlaylist = async () => {
    if (!selectedPlaylist.value) return false;

    if (selectedPlaylist.value.source === 'local') {
      return await loadLocalPlaylist(selectedPlaylist.value);
    }

    return await loadPlaylistFromApi(selectedPlaylist.value, { force: true });
  };

  const ensureAudio = () => {
    if (!currentSong.value.url) return null;

    if (!audio.value) {
      audio.value = new Audio();
      audio.value.preload = 'metadata';
      audio.value.addEventListener('timeupdate', () => {
        state.currentTime = audio.value.currentTime || 0;
        state.duration = audio.value.duration || 0;
      });
      audio.value.addEventListener('loadedmetadata', () => {
        state.duration = audio.value.duration || 0;
      });
      audio.value.addEventListener('durationchange', () => {
        state.duration = audio.value.duration || 0;
      });
      audio.value.addEventListener('play', () => {
        state.isPlaying = true;
      });
      audio.value.addEventListener('pause', () => {
        state.isPlaying = false;
      });
      audio.value.addEventListener('ended', () => {
        nextSong();
      });
      audio.value.addEventListener('error', () => {
        state.isPlaying = false;
        state.error = 'This track could not be played. Skipping to the next song.';
        nextSong();
      });
    }

    return audio.value;
  };

  const togglePlay = async () => {
    if (state.isLoading) return;

    if (state.isPlaying && audio.value) {
      const player = audio.value;
      player.pause();
      state.isPlaying = false;
      return;
    }

    await setAudioSource(true);
  };

  function nextSong() {
    if (!playlist.value.length) return;
    state.index = getNextIndex(1);
    setAudioSource(state.isPlaying);
  }

  const previousSong = () => {
    if (!playlist.value.length) return;
    state.index = getNextIndex(-1);
    setAudioSource(state.isPlaying);
  };

  const togglePlayMode = () => {
    state.playMode = state.playMode === 'order' ? 'random' : 'order';

    try {
      localStorage.setItem(PLAY_MODE_KEY, state.playMode);
    } catch {
      // Ignore storage failures.
    }
  };

  const clearLoginPoll = () => {
    if (pollTimer.value) {
      window.clearTimeout(pollTimer.value);
      pollTimer.value = null;
    }
    state.isPollingLogin = false;
  };

  const saveSession = (session, expiresAt) => {
    state.sessionToken = session || '';
    state.sessionExpiresAt = expiresAt || '';
    state.isLoggedIn = Boolean(session);

    try {
      if (session) {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ session, expiresAt }));
      } else {
        localStorage.removeItem(SESSION_KEY);
      }
    } catch {
      // Ignore storage failures.
    }
  };

  const restoreSession = () => {
    try {
      const cached = safeJsonParse(localStorage.getItem(SESSION_KEY));
      if (!cached?.session || !cached.expiresAt || Date.now() > new Date(cached.expiresAt).getTime()) {
        saveSession('', '');
        return;
      }

      saveSession(cached.session, cached.expiresAt);
      state.loginStatus = 'success';
      state.loginMessage = 'Music login restored.';
    } catch {
      saveSession('', '');
    }
  };

  const pollLoginStatus = async () => {
    if (!state.loginState && !state.loginKey) return;

    try {
      const data = await fetchJson(
        buildMusicEndpoint('/login/qr/check', {
          server: state.loginServer,
          state: state.loginState,
          key: state.loginKey,
        }),
        { headers: {} },
      );

      state.loginMessage = data.message || 'Waiting for confirmation...';
      state.loginStatus = Number(data.code) === LOGIN_SUCCESS_CODE ? 'success' : 'pending';

      if (Number(data.code) === LOGIN_SUCCESS_CODE) {
        clearLoginPoll();
        if (!data.session) throw new Error('Login succeeded, but the API did not return a session token.');

        saveSession(data.session, data.expiresAt);
        state.isLoginOpen = false;
        state.loginMessage = 'Login successful. Refreshing playlist...';
        await refreshPlaylist();
        return;
      }

      if (Number(data.code) === LOGIN_EXPIRED_CODE) {
        clearLoginPoll();
        state.loginStatus = 'error';
        state.loginMessage = data.message || 'QR code expired. Please create a new one.';
        return;
      }

      pollTimer.value = window.setTimeout(pollLoginStatus, LOGIN_POLL_MS);
    } catch (error) {
      clearLoginPoll();
      state.loginStatus = 'error';
      state.loginMessage = error?.message || 'QR login check failed.';
    }
  };

  const startQrLogin = async () => {
    clearLoginPoll();
    state.isLoginOpen = true;
    state.isPollingLogin = true;
    state.loginStatus = 'pending';
    state.loginMessage = 'Creating login QR code...';
    state.qrImage = '';
    state.qrUrl = '';
    state.loginState = '';
    state.loginKey = '';
    state.scanApp = '';

    try {
      const data = await fetchJson(buildMusicEndpoint('/login/qr', { server: state.loginServer }), { headers: {} });
      state.qrImage = data.qrimg || '';
      state.qrUrl = data.qrurl || '';
      state.loginState = data.state || '';
      state.loginKey = data.key || data.unikey || data.qrsig || '';
      state.scanApp = data.scanApp || data.type || state.loginServer;
      state.loginMessage = data.message || `Scan with ${state.scanApp}.`;
      state.isPollingLogin = true;
      pollTimer.value = window.setTimeout(pollLoginStatus, LOGIN_POLL_MS);
    } catch (error) {
      clearLoginPoll();
      state.loginStatus = 'error';
      state.loginMessage = error?.message || 'Could not create login QR code.';
    }
  };

  const cancelQrLogin = () => {
    clearLoginPoll();
    state.isLoginOpen = false;
    state.qrImage = '';
    state.qrUrl = '';
  };

  const logoutMusic = async () => {
    clearLoginPoll();
    saveSession('', '');
    state.loginStatus = 'idle';
    state.loginMessage = 'Logged out.';
    await refreshPlaylist();
  };

  const progressText = computed(() => {
    const fmt = (value) => {
      const minutes = Math.floor(value / 60) || 0;
      const seconds = Math.floor(value % 60).toString().padStart(2, '0');
      return `${minutes}:${seconds}`;
    };
    return `${fmt(state.currentTime)} / ${fmt(state.duration || 0)}`;
  });

  onMounted(async () => {
    try {
      const storedMode = localStorage.getItem(PLAY_MODE_KEY);
      if (storedMode === 'random' || storedMode === 'order') state.playMode = storedMode;

      const storedPlaylist = localStorage.getItem(PLAYLIST_KEY);
      if (storedPlaylist && playlists.value.some((item) => item.key === storedPlaylist)) {
        state.selectedPlaylistKey = storedPlaylist;
        state.selectedPlaylistName = playlists.value.find((item) => item.key === storedPlaylist)?.name || defaultPlaylist.name;
      }
    } catch {
      // Ignore storage failures.
    }

    restoreSession();
    await switchPlaylist(state.selectedPlaylistKey);
  });

  onBeforeUnmount(() => {
    clearLoginPoll();
    if (audio.value) {
      audio.value.pause();
      audio.value.src = '';
      audio.value = null;
    }
  });

  return {
    musicState: state,
    playlist,
    playlists,
    selectedPlaylist,
    currentSong,
    lyrics,
    activeLyricIndex,
    togglePlay,
    nextSong,
    previousSong,
    togglePlayMode,
    switchPlaylist,
    refreshPlaylist,
    loadPlaylistFromApi,
    loadCustomPlaylist,
    startQrLogin,
    cancelQrLogin,
    logoutMusic,
    progressText,
  };
}
