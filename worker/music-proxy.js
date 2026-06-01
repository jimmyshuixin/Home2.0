import Meting from '@meting/core';

const DEFAULT_SERVER = 'tencent';
const DEFAULT_TYPE = 'playlist';
const DEFAULT_PLAYLIST_ID = '9206816111';
const DEFAULT_LIMIT = 18;
const HARD_MAX_LIMIT = 30;
const DEFAULT_CACHE_TTL = 60 * 30;
const DEFAULT_BITRATE = 320;
const DEFAULT_COVER_SIZE = 300;
const DEFAULT_CONCURRENCY = 3;

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
        const healthResponse = jsonResponse(
          {
            ok: true,
            service: 'home-music-api',
            metingVersion: METING_VERSION,
            supportedServers: [...SUPPORTED_SERVERS],
            defaultServer: env.METING_DEFAULT_SERVER || DEFAULT_SERVER,
            defaultType: env.METING_DEFAULT_TYPE || DEFAULT_TYPE,
          },
          200,
          cors,
          { 'Cache-Control': 'no-store' },
        );

        return request.method === 'HEAD' ? new Response(null, healthResponse) : healthResponse;
      }

      const params = readParams(request, env);
      const cache = request.method === 'GET' ? globalThis.caches?.default : null;
      const cacheKey = new Request(url.toString(), request);
      const cached = cache ? await cache.match(cacheKey) : null;

      if (cached) {
        return withCors(cached, cors, request.method === 'HEAD');
      }

      const payload = await resolveMusic(params, env);
      const response = jsonResponse(payload, 200, cors, {
        'Cache-Control': `public, max-age=${params.cacheTtl}`,
      });

      if (cache && ctx?.waitUntil) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }

      return request.method === 'HEAD' ? new Response(null, response) : response;
    } catch (error) {
      const status = error.status || 500;
      return jsonResponse({ error: error.message || 'Music API error' }, status, cors);
    }
  },
};

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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function readParams(request, env) {
  const url = new URL(request.url);
  const server = cleanToken(url.searchParams.get('server') || env.METING_DEFAULT_SERVER || DEFAULT_SERVER);
  const type = cleanToken(url.searchParams.get('type') || env.METING_DEFAULT_TYPE || DEFAULT_TYPE);
  const id = String(url.searchParams.get('id') || env.METING_DEFAULT_ID || DEFAULT_PLAYLIST_ID).trim();

  if (!SUPPORTED_SERVERS.has(server)) {
    throw httpError(400, `Unsupported music server: ${server}`);
  }

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
    includeLyric: url.searchParams.get('lyric') === '1',
    cacheTtl: clampNumber(env.METING_CACHE_TTL, 0, 86400, DEFAULT_CACHE_TTL),
  };
}

async function resolveMusic(params, env) {
  const meting = createMeting(params.server, env);

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
  const songs = await enrichSongs(rawSongs, params, env);

  if (rawSongs.length && !songs.length) {
    throw httpError(
      502,
      `Meting returned ${rawSongs.length} ${params.server} track(s), but none had playable URLs. Configure METING_COOKIE_${params.server.toUpperCase()} or use another playlist/server.`,
    );
  }

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

async function enrichSongs(songs, params, env) {
  const results = new Array(songs.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(params.concurrency, songs.length) }, async () => {
    while (nextIndex < songs.length) {
      const index = nextIndex;
      const song = songs[index];
      nextIndex += 1;
      const enriched = await enrichSong(song, params, env);
      if (enriched?.url) results[index] = enriched;
    }
  });

  await Promise.all(workers);

  return results.filter(Boolean);
}

async function enrichSong(song, params, env) {
  const id = song.url_id || song.id;
  if (!id) return null;

  const meting = createMeting(params.server, env);
  const [urlInfo, picInfo, lyricInfo] = await Promise.all([
    meting.url(id, params.bitrate).then((value) => parseMetingJson(value, {})).catch(() => ({})),
    meting.pic(song.pic_id || song.id, params.coverSize).then((value) => parseMetingJson(value, {})).catch(() => ({})),
    params.includeLyric
      ? meting.lyric(song.lyric_id || song.id).then((value) => parseMetingJson(value, {})).catch(() => ({}))
      : Promise.resolve({}),
  ]);

  return {
    id: song.id,
    name: song.name || 'Unknown Track',
    artist: Array.isArray(song.artist) ? song.artist : song.artist ? [song.artist] : [],
    album: song.album || '',
    source: song.source || params.server,
    url: urlInfo.url || '',
    cover: picInfo.url || '',
    lrc: lyricInfo.lyric || '',
    br: urlInfo.br || null,
  };
}

function createMeting(server, env) {
  const meting = new Meting(server);
  meting.format(true);

  const cookie = env[`METING_COOKIE_${server.toUpperCase()}`] || env.METING_COOKIE;
  if (cookie) meting.cookie(cookie);

  return meting;
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

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
