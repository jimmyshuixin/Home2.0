import Meting from '../Meting/src/meting.js';
import { createMusicLoginPage } from './music-login-page.js';
export { MusicSessionStore } from './music-session-store.js';

const DEFAULT_SERVER = 'tencent';
const DEFAULT_TYPE = 'playlist';
const DEFAULT_PLAYLIST_ID = '9206816111';
const DEFAULT_LIMIT = 'all';
const HARD_MAX_LIMIT = 500;
const DEFAULT_QUERY_LIMIT = 50;
const DEFAULT_CACHE_TTL = 60 * 20;
const DEFAULT_SESSION_TTL = 60 * 60 * 24 * 30;
const DEFAULT_BITRATE = 320;
const DEFAULT_COVER_SIZE = 300;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MEDIA_MODE = 'deferred';
const TOKEN_PREFIX_V1 = 'meting-session.v1.';
const TOKEN_PREFIX_V2 = 'meting-session.v2.';
const LOGIN_SERVER = 'tencent';
const SESSION_STORE_NAME = 'qq-music-account';
const DEFERRED_MEDIA_SERVERS = new Set(['tencent']);

const SUPPORTED_SERVERS = new Set(Meting.getSupportedPlatforms());
const SUPPORTED_TYPES = new Set([
  'playlist',
  'song',
  'album',
  'artist',
  'search',
  'url',
  'pic',
  'lyric',
  'lrc',
  'user_playlists',
  'user-playlists',
  'playlists',
]);
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const METING_VERSION = new Meting(DEFAULT_SERVER).VERSION || 'unknown';

export default {
  async fetch(request, env, ctx) {
    const cors = createCorsHeaders(request, env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const isLogout = request.method === 'POST' && url.pathname === '/session/logout';
    if (request.method !== 'GET' && request.method !== 'HEAD' && !isLogout) {
      return jsonResponse({ error: 'Method not allowed' }, 405, cors);
    }

    try {
      if (url.pathname === '/' && !url.search) {
        return Response.redirect(`${url.origin}/login`, 302);
      }

      if (url.pathname === '/login') {
        return htmlResponse(createMusicLoginPage(), 200, cors);
      }

      if (url.pathname === '/health') {
        return maybeHead(
          request,
          jsonResponse(
            {
              ok: true,
              service: env.WORKER_SERVICE_NAME || 'music-proxy',
              metingVersion: METING_VERSION,
              supportedServers: [...SUPPORTED_SERVERS],
              defaultServer: env.METING_DEFAULT_SERVER || DEFAULT_SERVER,
              defaultType: env.METING_DEFAULT_TYPE || DEFAULT_TYPE,
              login: {
                qr: true,
                server: LOGIN_SERVER,
                persistent: hasPersistentSessionStore(env),
                adminProtected: Boolean(env.MUSIC_ADMIN_TOKEN),
                sessionSecret: Boolean(getSessionSecret(env, false)),
              },
            },
            200,
            cors,
            { 'Cache-Control': 'no-store' },
          ),
        );
      }

      if (url.pathname === '/login/qr') {
        return maybeHead(request, await handleLoginQr(request, env, cors));
      }

      if (url.pathname === '/login/qr/check') {
        return maybeHead(request, await handleLoginQrCheck(request, env, cors));
      }

      if (url.pathname === '/session/status') {
        return maybeHead(request, await handleSessionStatus(request, env, cors));
      }

      if (url.pathname === '/session/logout') {
        return await handleSessionLogout(request, env, cors);
      }

      if (url.pathname === '/debug/url') {
        return maybeHead(request, await handleDebugUrl(request, env, cors));
      }

      if (url.pathname === '/me/playlists' || url.pathname === '/user/playlists') {
        return maybeHead(request, await handleUserPlaylists(request, env, cors));
      }

      const params = readParams(request, env);
      const canCache =
        request.method === 'GET' && !params.sessionToken && params.type !== 'url' && params.cacheTtl > 0;
      const cache = canCache ? globalThis.caches?.default : null;
      const cacheKey = new Request(url.toString(), request);
      const cached = cache ? await cache.match(cacheKey) : null;

      if (cached) {
        return withCors(cached, cors, request.method === 'HEAD');
      }

      const payload = await resolveMusic(params, env);
      const response = jsonResponse(payload, 200, cors, {
        'Cache-Control': params.sessionToken ? 'private, no-store' : `public, max-age=${params.cacheTtl}`,
      });

      if (cache && ctx?.waitUntil) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }

      return maybeHead(request, response);
    } catch (error) {
      const status = error.status || 500;
      return jsonResponse({ error: error.message || 'Music API error' }, status, cors);
    }
  },
};

async function handleLoginQr(request, env, cors) {
  assertMusicAdmin(request, env);
  const url = new URL(request.url);
  const server = readLoginServer(url.searchParams.get('server') || url.searchParams.get('platform'));
  const meting = createMeting(server, env);
  const result = parseMetingJson(await meting.loginQr({ server, includeQrImage: true }), {});

  return jsonResponse(sanitizeLoginResult(result), 200, cors, { 'Cache-Control': 'no-store' });
}

async function handleLoginQrCheck(request, env, cors) {
  assertMusicAdmin(request, env);
  const url = new URL(request.url);
  const server = readLoginServer(url.searchParams.get('server') || url.searchParams.get('platform'));
  const state = String(url.searchParams.get('state') || '').trim();
  const key = String(url.searchParams.get('key') || '').trim();

  if (!state && !key) {
    throw httpError(400, 'Missing state or key query parameter');
  }

  const meting = createMeting(server, env);
  const result = parseMetingJson(await meting.loginQrCheck(state || key), {});
  const cookie = result.cookieHeader || result.cookie || '';

  if (Number(result.code) === 803 && cookie) {
    const sessionTtl = clampNumber(env.METING_SESSION_TTL, 300, 60 * 60 * 24 * 180, DEFAULT_SESSION_TTL);
    const expiresAt = Date.now() + sessionTtl * 1000;
    const credential = inspectTencentCredential(cookie);

    const sessionPayload = {
      server: result.server || result.platform || server,
      cookie,
      expiresAt,
    };

    if (hasPersistentSessionStore(env)) {
      await writePersistentSession(
        {
          ...sessionPayload,
          id: crypto.randomUUID(),
          createdAt: Date.now(),
        },
        env,
      );
    } else {
      result.session = await createSessionToken(sessionPayload, env);
    }
    result.expiresAt = new Date(expiresAt).toISOString();
    result.cookieStored = hasPersistentSessionStore(env);
    result.persistent = hasPersistentSessionStore(env);
    result.credential = credential;

    if (!credential.musicKey) {
      result.message = 'QQ login saved. Playback will use the authenticated web-cookie fallback.';
    }
  } else if (Number(result.code) === 803) {
    result.message = 'QQ login succeeded, but QQ Music did not return a reusable session cookie.';
  }

  return jsonResponse(sanitizeLoginResult(result), 200, cors, { 'Cache-Control': 'no-store' });
}

async function handleSessionStatus(request, env, cors) {
  const url = new URL(request.url);
  const server = readLoginServer(url.searchParams.get('server') || url.searchParams.get('platform'));
  const token = readSessionTokenFromRequest(request);
  const session = token ? await readSession(token, env) : await readPersistentSession('', env);
  const ok = Boolean(session?.cookie && (!server || session.server === server));
  const credential = inspectTencentCredential(session?.cookie || '');

  return jsonResponse(
    {
      ok,
      server: session?.server || server,
      expiresAt: session?.expiresAt ? new Date(session.expiresAt).toISOString() : '',
      authenticated: Boolean(ok && credential.uin && credential.musicKey),
      persistent: hasPersistentSessionStore(env),
    },
    ok ? 200 : 401,
    cors,
    { 'Cache-Control': 'no-store' },
  );
}

async function handleSessionLogout(request, env, cors) {
  const token = readSessionTokenFromRequest(request);
  if (!token) {
    assertMusicAdmin(request, env);
    await deletePersistentSession('', env);
    return jsonResponse({ ok: true }, 200, cors, { 'Cache-Control': 'no-store' });
  }

  const session = await readSession(token, env);
  if (session?.id && hasPersistentSessionStore(env)) {
    await deletePersistentSession(session.id, env);
  }

  return jsonResponse({ ok: true }, 200, cors, { 'Cache-Control': 'no-store' });
}

async function handleDebugUrl(request, env, cors) {
  assertMusicAdmin(request, env);
  const url = new URL(request.url);
  const server = readLoginServer(url.searchParams.get('server') || url.searchParams.get('platform'));
  const id = String(url.searchParams.get('id') || '').trim();
  const bitrate = clampNumber(url.searchParams.get('br'), 96, 9999, 320);
  if (!id) throw httpError(400, 'Missing song id');

  const sessionCookie = await readSessionCookie('', server, env, { allowPersistent: true });
  const meting = createMeting(server, env, sessionCookie);
  const result = parseMetingJson(await meting.url(id, bitrate), {});
  const [egress, directStream] = await Promise.all([
    probeWorkerEgress(),
    probeTencentLegacyStream(id, sessionCookie),
  ]);
  return jsonResponse(
    {
      ok: Boolean(result.url),
      url: result.url || '',
      br: result.br ?? -1,
      code: result.code ?? null,
      strategy: result.strategy || '',
      diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics : [],
      credential: inspectTencentCredential(sessionCookie),
      execution: {
        colo: request.cf?.colo || '',
        country: request.cf?.country || '',
        egress,
      },
      directStream,
    },
    200,
    cors,
    { 'Cache-Control': 'no-store' },
  );
}

async function handleUserPlaylists(request, env, cors) {
  const url = new URL(request.url);
  const server = readServer(url.searchParams.get('server') || url.searchParams.get('platform'), env);
  const limit = clampNumber(url.searchParams.get('limit'), 1, 200, 200);
  const offset = clampNumber(url.searchParams.get('offset'), 0, 5000, 0);
  const sessionCookie = await readSessionCookie(readSessionTokenFromRequest(request), server, env);
  const payload = await resolveUserPlaylists(server, env, sessionCookie, { limit, offset });

  return jsonResponse(payload, 200, cors, { 'Cache-Control': 'private, no-store' });
}

function createCorsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = String(env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const allowAny = allowedOrigins.includes('*') || allowedOrigins.length === 0;
  const allowOrigin = allowAny || allowedOrigins.includes(origin) ? (allowAny ? '*' : origin) : allowedOrigins[0];

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Music-Admin-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function readParams(request, env) {
  const url = new URL(request.url);
  const server = readServer(url.searchParams.get('server'), env);
  const type = cleanToken(url.searchParams.get('type') || env.METING_DEFAULT_TYPE || DEFAULT_TYPE);
  const id = String(url.searchParams.get('id') || env.METING_DEFAULT_ID || DEFAULT_PLAYLIST_ID).trim();

  if (!SUPPORTED_TYPES.has(type)) {
    throw httpError(400, `Unsupported music type: ${type}`);
  }

  if (!id || id.length > 160) {
    throw httpError(400, 'A valid id is required');
  }

  if (type !== 'search' && !PUBLIC_ID_PATTERN.test(id)) {
    throw httpError(400, 'The id contains unsupported characters');
  }

  const limit = readLimit(url.searchParams.get('limit'), env);

  return {
    server,
    type,
    id,
    page: clampNumber(url.searchParams.get('page'), 1, 100, 1),
    limit: limit.value,
    limitAll: limit.all,
    bitrate: clampNumber(url.searchParams.get('br') || env.METING_BITRATE, 64, 999, DEFAULT_BITRATE),
    coverSize: clampNumber(url.searchParams.get('cover') || env.METING_COVER_SIZE, 100, 1000, DEFAULT_COVER_SIZE),
    concurrency: clampNumber(env.METING_CONCURRENCY, 1, 5, DEFAULT_CONCURRENCY),
    includeLyric: url.searchParams.get('lyric') === '1' || url.searchParams.get('lrc') === '1',
    sessionToken: readSessionTokenFromRequest(request),
    cacheTtl: clampNumber(env.METING_CACHE_TTL, 0, 86400, DEFAULT_CACHE_TTL),
    deferMedia: shouldDeferMedia(server, env),
    apiBaseUrl: `${url.origin}${url.pathname}`,
  };
}

function readServer(value, env) {
  const server = cleanToken(value || env.METING_DEFAULT_SERVER || DEFAULT_SERVER);

  if (!SUPPORTED_SERVERS.has(server)) {
    throw httpError(400, `Unsupported music server: ${server}`);
  }

  return server;
}

function readLoginServer(value) {
  const server = cleanToken(value || LOGIN_SERVER);
  if (server !== LOGIN_SERVER) {
    throw httpError(400, 'Only QQ Music login is supported');
  }
  return LOGIN_SERVER;
}

function assertMusicAdmin(request, env) {
  const expected = String(env.MUSIC_ADMIN_TOKEN || '');
  if (!expected) return;

  const actual = request.headers.get('X-Music-Admin-Token') || '';
  if (!timingSafeEqual(actual, expected)) {
    throw httpError(403, 'Music admin token is required');
  }
}

async function resolveMusic(params, env) {
  const sessionCookie = await readSessionCookie(params.sessionToken, params.server, env, {
    allowPersistent: params.server === LOGIN_SERVER && params.type === 'url',
  });
  const meting = createMeting(params.server, env, sessionCookie);

  if (params.type === 'user_playlists' || params.type === 'user-playlists' || params.type === 'playlists') {
    return await resolveUserPlaylists(params.server, env, sessionCookie, {
      limit: params.limitAll ? 200 : params.limit,
      offset: 0,
    });
  }

  if (params.type === 'url') {
    const result = parseMetingJson(await meting.url(params.id, params.bitrate), {});
    if (!result.url) {
      const regionRestricted = hasTencentResultCode(result, 104003);
      console.warn(
        JSON.stringify({
          event: 'tencent_url_resolution_failed',
          songId: params.id,
          code: result.code ?? null,
          regionRestricted,
          message: result.message || '',
          authenticated: Boolean(sessionCookie),
          credential: inspectTencentCredential(sessionCookie),
        }),
      );
      if (sessionCookie) {
        return {
          ok: false,
          url: '',
          playable: false,
          code: regionRestricted ? 'QQ_REGION_RESTRICTED' : 'QQ_URL_UNAVAILABLE',
          message: regionRestricted
            ? 'QQ Music blocked this media request outside mainland China.'
            : result.message || 'QQ Music did not return a playable URL.',
        };
      }
      throw httpError(401, result.message || 'QQ Music login is required to resolve this track');
    }
    return {
      ...result,
      url: String(result.url).replace(/^http:/i, 'https:'),
    };
  }

  if (params.type === 'pic') {
    return parseMetingJson(await meting.pic(params.id, params.coverSize), {});
  }

  if (params.type === 'lyric' || params.type === 'lrc') {
    return parseMetingJson(await meting.lyric(params.id), {});
  }

  const rawSongs = await getSongRecords(meting, params);

  if (!rawSongs.length) {
    throw httpError(502, `No songs were returned for this ${params.server} ${params.type}`);
  }

  const songs = await enrichSongs(rawSongs, params, env, sessionCookie);

  return songs;
}

async function resolveUserPlaylists(server, env, sessionCookie, option = {}) {
  const meting = createMeting(server, env, sessionCookie);
  const cookie = sessionCookie || env[`METING_COOKIE_${server.toUpperCase()}`] || env.METING_COOKIE || '';

  if (!cookie) {
    throw httpError(401, 'Login session is required to read user playlists');
  }

  return parseMetingJson(await meting.userPlaylists(null, option), {
    code: -1,
    server,
    platform: server,
    playlists: [],
  });
}

async function getSongRecords(meting, params) {
  const queryLimit = params.limitAll ? DEFAULT_QUERY_LIMIT : params.limit;
  const methods = {
    playlist: () => meting.playlist(params.id),
    song: () => meting.song(params.id),
    album: () => meting.album(params.id),
    artist: () => meting.artist(params.id, queryLimit),
    search: () => meting.search(params.id, { page: params.page, limit: queryLimit }),
  };

  const result = await methods[params.type]();
  const parsed = parseMetingJson(result, []);
  return limitSongs(Array.isArray(parsed) ? parsed : [parsed], params);
}

function limitSongs(songs, params) {
  return params.limitAll ? songs : songs.slice(0, params.limit);
}

async function enrichSongs(songs, params, env, sessionCookie) {
  const results = new Array(songs.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(params.concurrency, songs.length) }, async () => {
    while (nextIndex < songs.length) {
      const index = nextIndex;
      const song = songs[index];
      nextIndex += 1;
      const enriched = await enrichSong(song, params, env, sessionCookie);
      if (enriched) results[index] = enriched;
    }
  });

  await Promise.all(workers);

  return results.filter(Boolean);
}

async function enrichSong(song, params, env, sessionCookie) {
  const id = song.url_id || song.id;
  if (!id) return null;

  if (params.deferMedia) {
    return await enrichDeferredSong(song, params, env, sessionCookie);
  }

  const meting = createMeting(params.server, env, sessionCookie);
  const [urlInfo, picInfo, lyricInfo] = await Promise.all([
    meting
      .url(id, params.bitrate)
      .then((value) => parseMetingJson(value, {}))
      .catch(() => ({})),
    meting
      .pic(song.pic_id || song.id, params.coverSize)
      .then((value) => parseMetingJson(value, {}))
      .catch(() => ({})),
    params.includeLyric
      ? meting
          .lyric(song.lyric_id || song.id)
          .then((value) => parseMetingJson(value, {}))
          .catch(() => ({}))
      : Promise.resolve({}),
  ]);

  return {
    id: song.id,
    name: song.name || 'Unknown Track',
    artist: Array.isArray(song.artist) ? song.artist : song.artist ? [song.artist] : [],
    album: song.album || '',
    source: song.source || params.server,
    url: urlInfo.url || '',
    playable: Boolean(urlInfo.url),
    playError: urlInfo.url
      ? ''
      : urlInfo.message || `No playable URL returned for this ${params.server} track. Refresh login or try another track.`,
    cover: picInfo.url || '',
    lrc: lyricInfo.lyric || '',
    tlyric: lyricInfo.tlyric || '',
    br: urlInfo.br || null,
  };
}

async function enrichDeferredSong(song, params, env, sessionCookie) {
  const id = song.url_id || song.id;
  const picId = song.pic_id || song.id;
  const lyricId = song.lyric_id || song.id;
  const meting = createMeting(params.server, env, sessionCookie);
  const picInfo = await meting
    .pic(picId, params.coverSize)
    .then((value) => parseMetingJson(value, {}))
    .catch(() => ({}));
  const urlResolver = buildResolverEndpoint(params.apiBaseUrl, {
    server: params.server,
    type: 'url',
    id,
    br: params.bitrate,
  });
  const lrcUrl = buildResolverEndpoint(params.apiBaseUrl, {
    server: params.server,
    type: 'lrc',
    id: lyricId,
  });

  return {
    id: song.id,
    name: song.name || 'Unknown Track',
    artist: Array.isArray(song.artist) ? song.artist : song.artist ? [song.artist] : [],
    album: song.album || '',
    source: song.source || params.server,
    url: urlResolver,
    urlResolver,
    resolveUrl: true,
    playable: true,
    playError: '',
    cover: picInfo.url || '',
    pic: picInfo.url || '',
    lrc: '',
    lyric: '',
    lrcUrl,
    lyricUrl: lrcUrl,
    resolveLyrics: true,
    tlyric: '',
    br: params.bitrate,
  };
}

function readLimit(value, env) {
  const raw = String(value || env.METING_DEFAULT_LIMIT || DEFAULT_LIMIT).trim().toLowerCase();

  if (!raw || raw === 'all' || raw === 'full') {
    return { value: null, all: true };
  }

  const maxLimit = clampNumber(env.METING_MAX_LIMIT, 1, HARD_MAX_LIMIT, HARD_MAX_LIMIT);
  return {
    value: clampNumber(raw, 1, maxLimit, DEFAULT_QUERY_LIMIT),
    all: false,
  };
}

function shouldDeferMedia(server, env) {
  const mode = cleanToken(env.METING_MEDIA_MODE || DEFAULT_MEDIA_MODE);
  return mode === 'deferred' && DEFERRED_MEDIA_SERVERS.has(server);
}

function buildResolverEndpoint(baseUrl, query) {
  const url = new URL(baseUrl);

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

function createMeting(server, env, sessionCookie = '') {
  const meting = new Meting(server);
  meting.format(true);

  const cookie = sessionCookie || env[`METING_COOKIE_${server.toUpperCase()}`] || env.METING_COOKIE;
  if (cookie) meting.cookie(cookie);

  return meting;
}

async function readSessionCookie(token, expectedServer, env, option = {}) {
  const session = token
    ? await readSession(token, env)
    : option.allowPersistent
      ? await readPersistentSession('', env)
      : null;
  if (!session?.cookie) return '';

  if (expectedServer && session.server !== expectedServer) {
    throw httpError(401, `Music session belongs to ${session.server}, not ${expectedServer}`);
  }

  return session.cookie;
}

async function createSessionToken(payload, env) {
  const secret = getSessionSecret(env);
  const key = await getSessionEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  return `${TOKEN_PREFIX_V2}${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

async function readSession(token, env) {
  if (!token) return null;

  const value = String(token).trim();
  if (value.startsWith(TOKEN_PREFIX_V2)) {
    return await readEncryptedSession(value.slice(TOKEN_PREFIX_V2.length), env);
  }

  if (value.startsWith(TOKEN_PREFIX_V1)) {
    return await readSignedSession(value.slice(TOKEN_PREFIX_V1.length), env);
  }

  return null;
}

function hasPersistentSessionStore(env) {
  return Boolean(env.MUSIC_SESSION_STORE);
}

function getPersistentSessionStub(env) {
  const namespace = env.MUSIC_SESSION_STORE;
  if (!namespace) return null;

  if (typeof namespace.getByName === 'function') {
    return namespace.getByName(SESSION_STORE_NAME);
  }

  return namespace.get(namespace.idFromName(SESSION_STORE_NAME));
}

async function writePersistentSession(session, env) {
  const stub = getPersistentSessionStub(env);
  if (!stub) return false;

  const response = await stub.fetch('https://music-session.internal/session', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(session),
  });

  if (!response.ok) {
    throw httpError(500, 'Could not persist the QQ Music session');
  }
  return true;
}

async function readPersistentSession(sessionId, env) {
  const stub = getPersistentSessionStub(env);
  if (!stub) return null;

  const url = new URL('https://music-session.internal/session');
  if (sessionId) url.searchParams.set('id', sessionId);
  const response = await stub.fetch(url.toString());
  if (response.status === 404) return null;
  if (!response.ok) throw httpError(500, 'Could not read the QQ Music session');

  const body = await response.json();
  return body.session || null;
}

async function deletePersistentSession(sessionId, env) {
  const stub = getPersistentSessionStub(env);
  if (!stub) return false;

  const url = new URL('https://music-session.internal/session');
  if (sessionId) url.searchParams.set('id', sessionId);
  const response = await stub.fetch(url.toString(), { method: 'DELETE' });
  return response.ok;
}

function inspectTencentCredential(cookie) {
  const names = new Set(
    String(cookie || '')
      .split(';')
      .map((item) => item.trim().split('=', 1)[0])
      .filter(Boolean),
  );
  const nativeMusicKeyNames = ['qqmusic_key', 'qm_keyst', 'musickey', 'music_key', 'psrf_musickey'];
  const fallbackMusicKeyNames = ['p_skey', 'skey'];

  return {
    uin: ['qqmusic_uin', 'musicid', 'uin', 'ptui_loginuin', 'luin', 'superuin', 'p_uin', 'pt2gguin'].some(
      (name) => names.has(name),
    ),
    musicKey: [...nativeMusicKeyNames, ...fallbackMusicKeyNames].some((name) => names.has(name)),
    nativeMusicKey: nativeMusicKeyNames.some((name) => names.has(name)),
    fallbackMusicKey: fallbackMusicKeyNames.some((name) => names.has(name)),
    skey: names.has('p_skey') || names.has('skey'),
    cookieNames: [...names].sort(),
  };
}

function hasTencentResultCode(result, expectedCode) {
  return (Array.isArray(result?.diagnostics) ? result.diagnostics : []).some((diagnostic) =>
    (Array.isArray(diagnostic?.items) ? diagnostic.items : []).some(
      (item) => Number(item?.result) === Number(expectedCode),
    ),
  );
}

async function probeWorkerEgress() {
  try {
    const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
      headers: { Accept: 'text/plain' },
    });
    if (!response.ok) return { status: response.status };

    const values = Object.fromEntries(
      (await response.text())
        .split('\n')
        .map((line) => line.trim().split('=', 2))
        .filter(([key, value]) => key && value),
    );
    return {
      status: response.status,
      ip: values.ip || '',
      colo: values.colo || '',
      location: values.loc || '',
    };
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

async function probeTencentLegacyStream(id, cookie) {
  try {
    const detailUrl = new URL('https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg');
    detailUrl.search = new URLSearchParams({ songmid: id, platform: 'yqq', format: 'json' }).toString();
    const detailResponse = await fetch(detailUrl, {
      headers: {
        Accept: 'application/json',
        Cookie: cookie,
        Referer: 'https://y.qq.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const song = await detailResponse.json();
    const urlMap = song?.data?.[0]?.url || song?.data?.url || song?.url || {};
    const legacyPath = Object.values(urlMap).find((value) => typeof value === 'string' && value);
    if (!legacyPath) return { available: false };

    const streamUrl = new URL(/^https?:\/\//i.test(legacyPath) ? legacyPath : `https://${legacyPath}`);
    if (!streamUrl.hostname.endsWith('.qqmusic.qq.com')) return { available: false };

    const response = await fetch(streamUrl, {
      redirect: 'manual',
      headers: {
        Accept: '*/*',
        Cookie: cookie,
        Range: 'bytes=0-0',
        Referer: 'https://y.qq.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    await response.body?.cancel();

    return {
      available: true,
      host: streamUrl.hostname,
      status: response.status,
      clientIp: response.headers.get('Client-Ip') || response.headers.get('X-Client-Ip') || '',
      location: response.headers.get('Location') || '',
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readEncryptedSession(rest, env) {
  const parts = rest.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  try {
    const key = await getSessionEncryptionKey(getSessionSecret(env));
    const iv = base64UrlToBytes(parts[0]);
    const ciphertext = base64UrlToBytes(parts[1]);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return validateSession(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw httpError(401, 'Invalid music session');
  }
}

async function readSignedSession(rest, env) {
  const separator = rest.lastIndexOf('.');
  if (separator <= 0) return null;

  const body = rest.slice(0, separator);
  const signature = rest.slice(separator + 1);
  const expected = await sign(body, getSessionSecret(env));

  if (!timingSafeEqual(signature, expected)) {
    throw httpError(401, 'Invalid music session');
  }

  return validateSession(JSON.parse(base64UrlDecode(body)));
}

function validateSession(session) {
  if (!session.cookie || !session.server || !session.expiresAt) {
    throw httpError(401, 'Invalid music session payload');
  }

  if (Date.now() > Number(session.expiresAt)) {
    throw httpError(401, 'Music session expired');
  }

  return session;
}

async function getSessionEncryptionKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function getSessionSecret(env, required = true) {
  const secret = env.MUSIC_SESSION_SECRET || env.METING_SESSION_SECRET || '';

  if (required && String(secret).length < 24) {
    throw httpError(500, 'MUSIC_SESSION_SECRET must be configured as a Worker secret for QR login sessions');
  }

  return secret;
}

function readSessionTokenFromRequest(request) {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get('session');
  if (fromQuery) return fromQuery;

  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function sanitizeLoginResult(result) {
  const next = { ...result };
  delete next.cookie;
  delete next.cookieHeader;
  delete next.raw;
  return next;
}

function parseMetingJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonResponse(body, status, cors, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function htmlResponse(body, status, cors) {
  return new Response(body, {
    status,
    headers: {
      ...cors,
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function withCors(response, cors, isHead = false) {
  const headers = new Headers(response.headers);
  Object.entries(cors).forEach(([key, value]) => headers.set(key, value));

  return new Response(isHead ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function maybeHead(request, response) {
  if (request.method !== 'HEAD') return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function cleanToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function clampNumber(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function base64UrlEncode(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlDecode(value) {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function timingSafeEqual(left, right) {
  const leftValue = String(left);
  const rightValue = String(right);
  let diff = leftValue.length ^ rightValue.length;

  for (let index = 0; index < Math.max(leftValue.length, rightValue.length); index += 1) {
    diff |= leftValue.charCodeAt(index) ^ rightValue.charCodeAt(index);
  }

  return diff === 0;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
