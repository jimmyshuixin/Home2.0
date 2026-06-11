import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { fallbackMusicList, siteConfig } from '../data/site';

const PLAY_MODE_KEY = 'home-music-play-mode';
const PLAYLIST_KEY = 'home-music-selected-playlist';
const SESSION_KEY = 'home-music-session';
const PLAYLIST_CACHE_PREFIX = 'home-music-playlist:';
const PLAYLIST_CACHE_VERSION = 'full-playlist-v2';
const MEDIA_URL_MAX_AGE_MS = 1000 * 60 * 10;
const LOGIN_SUCCESS_CODE = 803;
const LOGIN_EXPIRED_CODE = 800;
const LOGIN_POLL_MS = 2400;
const ACCOUNT_PLAYLIST_LIMIT = 50;

const normalizePath = (value) => {
  if (typeof value !== 'string') return '';
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  return value.replace(/^\.\//, '/');
};

const normalizeSong = (song = {}) => {
  const artist = Array.isArray(song.artist) ? song.artist.join(' / ') : song.artist || song.author || 'Unknown Artist';
  const url = normalizePath(song.url || song.src || song.link);
  const urlResolver = normalizePath(song.urlResolver || (song.resolveUrl ? url : ''));
  const rawLrc = song.lrc || song.lyric || '';
  const lrcUrl = normalizePath(song.lrcUrl || song.lyricUrl || (/^https?:/i.test(rawLrc) ? rawLrc : ''));

  return {
    id: song.id || song.url_id || song.mid || song.name || '',
    name: song.name || song.title || song.songname || 'Unknown Track',
    artist,
    album: song.album || '',
    source: song.source || '',
    url,
    urlResolver,
    resolveUrl: Boolean(song.resolveUrl),
    resolvedAt: Number(song.resolvedAt || 0),
    playable: 'playable' in song ? Boolean(song.playable) : Boolean(url),
    playError: song.playError || song.message || '',
    cover: normalizePath(song.cover || song.pic || song.picture || song.image) || '/content/icon/32.png',
    lrc: lrcUrl && rawLrc === lrcUrl ? '' : rawLrc,
    lrcUrl,
    resolveLyrics: Boolean(song.resolveLyrics),
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

const safeMediaTime = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
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

const normalizeAccountPlaylistOption = (playlist = {}, server = siteConfig.music.server) => {
  const id = String(playlist.id || playlist.dissid || playlist.dirid || '').trim();
  if (!id) return null;

  return {
    key: `${server}:playlist:${id}`,
    id,
    name: playlist.name || playlist.diss_name || playlist.dissname || `QQ Playlist ${id}`,
    server,
    type: 'playlist',
    source: 'account',
    songCount: Number(playlist.song_count || playlist.songnum || 0),
  };
};

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
      url.searchParams.set('limit', String(siteConfig.music.limit || 'all'));
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

  const fetchText = async (url) => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), siteConfig.music.timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      const text = await response.text();
      if (!response.ok) throw new Error(`Music text request failed: ${response.status}`);
      return text;
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

  const resolvePlayableUrl = async (song, songIndex) => {
    const shouldRefresh =
      song?.urlResolver && (!song.resolvedAt || Date.now() - song.resolvedAt > MEDIA_URL_MAX_AGE_MS);
    if (!song?.resolveUrl && !shouldRefresh) return song?.url || '';

    const resolverUrl = song.urlResolver || song.url;
    if (!resolverUrl) return '';

    const data = await fetchJson(resolverUrl);
    const resolvedUrl = normalizePath(data?.url || '');
    if (!resolvedUrl) {
      throw new Error(data?.message || 'QQ Music did not return a playable URL. Please log in and try again.');
    }

    const current = playlist.value[songIndex];
    if (current?.id === song.id) {
      playlist.value.splice(songIndex, 1, {
        ...current,
        url: resolvedUrl,
        urlResolver: resolverUrl,
        resolveUrl: false,
        resolvedAt: Date.now(),
        playable: true,
        playError: '',
      });
    }

    return resolvedUrl;
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

    let playableUrl = currentSong.value.url;
    try {
      playableUrl = await resolvePlayableUrl(currentSong.value, state.index);
    } catch (error) {
      state.isPlaying = false;
      state.error = error?.message || 'This track could not be resolved.';
      return;
    }

    const player = ensureAudio();
    if (!player || !playableUrl) return;

    const desiredUrl = new URL(playableUrl, window.location.href).href;
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

  const loadLyricsForCurrentSong = async () => {
    const song = currentSong.value;
    if (!song?.lrcUrl || song.lrc) return false;

    const songIndex = state.index;
    const songId = song.id;

    try {
      const lrc = song.resolveLyrics
        ? (await fetchJson(song.lrcUrl))?.lyric || ''
        : await fetchText(song.lrcUrl);
      if (!String(lrc).trim()) return false;

      const current = playlist.value[songIndex];
      if (!current || current.id !== songId) return false;

      playlist.value.splice(songIndex, 1, { ...current, lrc });
      return true;
    } catch {
      return false;
    }
  };

  const fallbackToLocal = async (message) => {
    await applyPlaylist(fallbackMusicList.map(normalizeSong), 'local', false);
    state.error = message;
  };

  const loadPlaylistFromApi = async (playlistItem = selectedPlaylist.value, { force = false } = {}) => {
    const apiUrl = buildMusicApiUrl(playlistItem);
    if (!apiUrl) return false;

    const cacheKey = `${PLAYLIST_CACHE_VERSION}:${playlistItem.key}:${state.sessionToken ? 'auth' : 'public'}`;
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

  const loadAccountPlaylists = async ({ switchToFirst = false } = {}) => {
    if (!state.sessionToken) return [];

    const server = state.loginServer || siteConfig.music.server;
    state.loginMessage = 'Loading account playlists...';

    try {
      const data = await fetchJson(buildMusicEndpoint('/me/playlists', {
        server,
        limit: ACCOUNT_PLAYLIST_LIMIT,
      }));
      const accountPlaylists = (Array.isArray(data.playlists) ? data.playlists : [])
        .map((item) => normalizeAccountPlaylistOption(item, data.server || data.platform || server))
        .filter(Boolean);

      if (!accountPlaylists.length) {
        state.loginMessage = 'Login active, but no account playlists were returned.';
        return [];
      }

      const merged = new Map(playlists.value.map((item) => [item.key, item]));
      accountPlaylists.forEach((item) => {
        merged.set(item.key, { ...merged.get(item.key), ...item });
      });
      playlists.value = Array.from(merged.values());
      state.loginMessage = `Loaded ${accountPlaylists.length} QQ Music playlist${accountPlaylists.length > 1 ? 's' : ''}.`;

      if (switchToFirst) {
        await switchPlaylist(accountPlaylists[0].key, { force: true });
      }

      return accountPlaylists;
    } catch (error) {
      state.loginMessage = error?.message || 'Could not load account playlists.';
      return [];
    }
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
        state.currentTime = safeMediaTime(audio.value.currentTime);
        state.duration = safeMediaTime(audio.value.duration);
      });
      audio.value.addEventListener('loadedmetadata', () => {
        state.duration = safeMediaTime(audio.value.duration);
      });
      audio.value.addEventListener('durationchange', () => {
        state.duration = safeMediaTime(audio.value.duration);
      });
      audio.value.addEventListener('play', () => {
        state.isPlaying = true;
      });
      audio.value.addEventListener('pause', () => {
        state.isPlaying = false;
      });
      audio.value.addEventListener('ended', () => {
        nextSong(true);
      });
      audio.value.addEventListener('error', () => {
        state.isPlaying = false;
        state.error = 'This track could not be played. Skipping to the next song.';
        nextSong(true);
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

  function nextSong(shouldPlay = state.isPlaying) {
    if (!playlist.value.length) return Promise.resolve(false);
    state.index = getNextIndex(1);
    return setAudioSource(shouldPlay);
  }

  const previousSong = () => {
    if (!playlist.value.length) return;
    state.index = getNextIndex(-1);
    setAudioSource(state.isPlaying);
  };

  const selectTrack = async (index) => {
    const nextIndex = Number(index);
    if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= playlist.value.length || state.isLoading) {
      return false;
    }

    const nextTrack = playlist.value[nextIndex];
    if (!nextTrack?.url) {
      state.index = nextIndex;
      state.isPlaying = false;
      state.error = nextTrack?.playError || 'This track does not have a playable URL.';
      return false;
    }

    state.index = nextIndex;
    state.error = '';
    await setAudioSource(state.isPlaying);
    return true;
  };

  const seekTo = async (time) => {
    const nextTime = Number(time);
    if (!Number.isFinite(nextTime) || nextTime < 0 || !currentSong.value.url) return false;

    await setAudioSource(false);
    const player = ensureAudio();
    if (!player) return false;

    const duration = safeMediaTime(player.duration || state.duration);
    const boundedTime = duration ? Math.min(nextTime, duration) : nextTime;
    player.currentTime = boundedTime;
    state.currentTime = boundedTime;
    return true;
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
        state.loginMessage = 'Login successful. Loading account playlists...';
        const accountPlaylists = await loadAccountPlaylists({ switchToFirst: true });
        if (!accountPlaylists.length) await refreshPlaylist();
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
      const safeValue = safeMediaTime(value);
      const minutes = Math.floor(safeValue / 60);
      const seconds = Math.floor(safeValue % 60).toString().padStart(2, '0');
      return `${minutes}:${seconds}`;
    };
    return `${fmt(state.currentTime)} / ${fmt(state.duration)}`;
  });

  onMounted(async () => {
    let storedPlaylistKey = '';

    try {
      const storedMode = localStorage.getItem(PLAY_MODE_KEY);
      if (storedMode === 'random' || storedMode === 'order') state.playMode = storedMode;

      storedPlaylistKey = localStorage.getItem(PLAYLIST_KEY) || '';
      if (storedPlaylistKey && playlists.value.some((item) => item.key === storedPlaylistKey)) {
        state.selectedPlaylistKey = storedPlaylistKey;
        state.selectedPlaylistName = playlists.value.find((item) => item.key === storedPlaylistKey)?.name || defaultPlaylist.name;
      }
    } catch {
      // Ignore storage failures.
    }

    restoreSession();
    if (state.isLoggedIn) await loadAccountPlaylists();
    if (storedPlaylistKey && playlists.value.some((item) => item.key === storedPlaylistKey)) {
      state.selectedPlaylistKey = storedPlaylistKey;
      state.selectedPlaylistName = playlists.value.find((item) => item.key === storedPlaylistKey)?.name || defaultPlaylist.name;
    }
    await switchPlaylist(state.selectedPlaylistKey);
  });

  watch(
    () => [state.index, currentSong.value?.lrcUrl, currentSong.value?.lrc],
    () => {
      loadLyricsForCurrentSong();
    },
  );

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
    selectTrack,
    seekTo,
    togglePlayMode,
    switchPlaylist,
    refreshPlaylist,
    loadPlaylistFromApi,
    loadCustomPlaylist,
    loadAccountPlaylists,
    startQrLogin,
    cancelQrLogin,
    logoutMusic,
    progressText,
  };
}
