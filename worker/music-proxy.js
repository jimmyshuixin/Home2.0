import Meting from '../Meting/src/meting.js';

const DEFAULT_SERVER = 'tencent';
const DEFAULT_TYPE = 'playlist';
const DEFAULT_PLAYLIST_ID = '9206816111';
const DEFAULT_LIMIT = 18;
const HARD_MAX_LIMIT = 50;
const DEFAULT_CACHE_TTL = 60 * 20;
const DEFAULT_SESSION_TTL = 60 * 60 * 24 * 7;
const DEFAULT_BITRATE = 320;
const DEFAULT_COVER_SIZE = 300;
const DEFAULT_CONCURRENCY = 3;
const TOKEN_PREFIX = 'meting-session.v1.';

const SUPPORTED_SERVERS = new Set(Meting.getSupportedPlatforms());
const SUPPORTED_TYPES = new Set(['playlist', 'song', 'album', 'artist', 'search', 'url', 'pic', 'lyric', 'lrc']);
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const METING_VERSION = new Meting(DEFAULT_SERVER).VERSION || 'unknown';

export default {
  async fetch(request, env, ctx) {
    const cors = createCorsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: 'Method not allowed' }, 405, cors);
    }

    try {
      const url = new URL(request.url);

      if (url.pathname === '/health') {
        return maybeHead(
          request,
          jsonResponse(
            {
              ok: true,
              service: 'home-music-api',
              metingVersion: METING_VERSION,
              supportedServers: [...SUPPORTED_SERVERS],
              defaultServer: env.METING_DEFAULT_SERVER || DEFAULT_SERVER,
              defaultType: env.METING_DEFAULT_TYPE || DEFAULT_TYPE,
              login: {
                qr: true,
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

      const params = readParams(request, env);
      const canCache = request.method === 'GET' && !params.sessionToken && params.cacheTtl > 0;
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
  const url = new URL(request.url);
  const server = readServer(url.searchParams.get('server') || url.searchParams.get('platform'), env);
  const meting = createMeting(server, env);
  const result = parseMetingJson(await meting.loginQr({ server, includeQrImage: true }), {});

  return jsonResponse(sanitizeLoginResult(result), 200, cors, { 'Cache-Control': 'no-store' });
}

async function handleLoginQrCheck(request, env, cors) {
  const url = new URL(request.url);
  const server = readServer(url.searchParams.get('server') || url.searchParams.get('platform'), env);
  const state = String(url.searchParams.get('state') || '').trim();
  const key = String(url.searchParams.get('key') || '').trim();

  if (!state && !key) {
    throw httpError(400, 'Missing state or key query parameter');
  }

  const meting = createMeting(server, env);
  const result = parseMetingJson(await meting.loginQrCheck(state || key), {});
  const cookie = result.cookieHeader || result.cookie || '';

  if (Number(result.code) === 803 && cookie) {
    const sessionTtl = clampNumber(env.METING_SESSION_TTL, 300, 60 * 60 * 24 * 30, DEFAULT_SESSION_TTL);
    const expiresAt = Date.now() + sessionTtl * 1000;

    result.session = await createSessionToken(
      {
        server: result.server || result.platform || server,
        cookie,
        expiresAt,
      },
      env,
    );
    result.expiresAt = new Date(expiresAt).toISOString();
    result.cookieStored = true;
  }

  return jsonResponse(sanitizeLoginResult(result), 200, cors, { 'Cache-Control': 'no-store' });
}

async function handleSessionStatus(request, env, cors) {
  const url = new URL(request.url);
  const server = readServer(url.searchParams.get('server') || url.searchParams.get('platform'), env);
  const token = readSessionTokenFromRequest(request);
  const session = await readSession(token, env);
  const ok = Boolean(session?.cookie && (!server || session.server === server));

  return jsonResponse(
    {
      ok,
      server: session?.server || server,
      expiresAt: session?.expiresAt ? new Date(session.expiresAt).toISOString() : '',
    },
    ok ? 200 : 401,
    cors,
    { 'Cache-Control': 'no-store' },
  );
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
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

  const maxLimit = clampNumber(env.METING_MAX_LIMIT, 1, HARD_MAX_LIMIT, HARD_MAX_LIMIT);

  return {
    server,
    type,
    id,
    page: clampNumber(url.searchParams.get('page'), 1, 100, 1),
    limit: clampNumber(url.searchParams.get('limit') || env.METING_DEFAULT_LIMIT, 1, maxLimit, DEFAULT_LIMIT),
    bitrate: clampNumber(url.searchParams.get('br') || env.METING_BITRATE, 64, 999, DEFAULT_BITRATE),
    coverSize: clampNumber(url.searchParams.get('cover') || env.METING_COVER_SIZE, 100, 1000, DEFAULT_COVER_SIZE),
    concurrency: clampNumber(env.METING_CONCURRENCY, 1, 5, DEFAULT_CONCURRENCY),
    includeLyric: url.searchParams.get('lyric') === '1' || url.searchParams.get('lrc') === '1',
    sessionToken: readSessionTokenFromRequest(request),
    cacheTtl: clampNumber(env.METING_CACHE_TTL, 0, 86400, DEFAULT_CACHE_TTL),
  };
}

function readServer(value, env) {
  const server = cleanToken(value || env.METING_DEFAULT_SERVER || DEFAULT_SERVER);

  if (!SUPPORTED_SERVERS.has(server)) {
    throw httpError(400, `Unsupported music server: ${server}`);
  }

  return server;
}

async function resolveMusic(params, env) {
  const sessionCookie = await readSessionCookie(params.sessionToken, params.server, env);
  const meting = createMeting(params.server, env, sessionCookie);

  if (params.type === 'url') {
    return parseMetingJson(await meting.url(params.id, params.bitrate), {});
  }

  if (params.type === 'pic') {
    return parseMetingJson(await meting.pic(params.id, params.coverSize), {});
  }

  if (params.type === 'lyric' || params.type === 'lrc') {
    return parseMetingJson(await meting.lyric(params.id), {});
  }

  const rawSongs = await getSongRecords(meting, params);
  const songs = await enrichSongs(rawSongs, params, env, sessionCookie);

  return songs;
}

async function getSongRecords(meting, params) {
  const methods = {
    playlist: () => meting.playlist(params.id),
    song: () => meting.song(params.id),
    album: () => meting.album(params.id),
    artist: () => meting.artist(params.id, params.limit),
    search: () => meting.search(params.id, { page: params.page, limit: params.limit }),
  };

  const result = await methods[params.type]();
  const parsed = parseMetingJson(result, []);
  return (Array.isArray(parsed) ? parsed : [parsed]).slice(0, params.limit);
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

function createMeting(server, env, sessionCookie = '') {
  const meting = new Meting(server);
  meting.format(true);

  const cookie = sessionCookie || env[`METING_COOKIE_${server.toUpperCase()}`] || env.METING_COOKIE;
  if (cookie) meting.cookie(cookie);

  return meting;
}

async function readSessionCookie(token, expectedServer, env) {
  if (!token) return '';

  const session = await readSession(token, env);
  if (!session?.cookie) return '';

  if (expectedServer && session.server !== expectedServer) {
    throw httpError(401, `Music session belongs to ${session.server}, not ${expectedServer}`);
  }

  return session.cookie;
}

async function createSessionToken(payload, env) {
  const secret = getSessionSecret(env);
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = await sign(body, secret);
  return `${TOKEN_PREFIX}${body}.${signature}`;
}

async function readSession(token, env) {
  if (!token) return null;

  const value = String(token).trim();
  if (!value.startsWith(TOKEN_PREFIX)) return null;

  const rest = value.slice(TOKEN_PREFIX.length);
  const separator = rest.lastIndexOf('.');
  if (separator <= 0) return null;

  const body = rest.slice(0, separator);
  const signature = rest.slice(separator + 1);
  const expected = await sign(body, getSessionSecret(env));

  if (!timingSafeEqual(signature, expected)) {
    throw httpError(401, 'Invalid music session');
  }

  const session = JSON.parse(base64UrlDecode(body));
  if (!session.cookie || !session.server || !session.expiresAt) {
    throw httpError(401, 'Invalid music session payload');
  }

  if (Date.now() > Number(session.expiresAt)) {
    throw httpError(401, 'Music session expired');
  }

  return session;
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
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
