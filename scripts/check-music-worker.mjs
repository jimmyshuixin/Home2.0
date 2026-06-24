import worker from '../worker/music-proxy.js';

const env = {
  ALLOWED_ORIGINS: '*',
  METING_DEFAULT_SERVER: 'tencent',
  METING_DEFAULT_TYPE: 'playlist',
  METING_DEFAULT_ID: '9206816111',
  METING_DEFAULT_LIMIT: '1',
  METING_MAX_LIMIT: '3',
  METING_BITRATE: '320',
  METING_COVER_SIZE: '300',
  METING_CONCURRENCY: '1',
  METING_CACHE_TTL: '0',
  MUSIC_SESSION_SECRET: 'local-dev-session-secret-for-smoke-tests',
};

const ctx = { waitUntil() {} };

async function call(path) {
  const response = await worker.fetch(new Request(`https://music.local${path}`), env, ctx);
  const text = await response.text();
  let body;

  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return { status: response.status, body };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const health = await call('/health');
assert(health.status === 200, `Expected /health to return 200, got ${health.status}`);
assert(health.body?.ok === true, 'Expected /health response to include ok=true');
assert(health.body?.service === 'music-proxy', 'Expected /health to identify the music-proxy Worker');
assert(Array.isArray(health.body?.supportedServers), 'Expected /health to list supported servers');
assert(health.body?.login?.server === 'tencent', 'Expected QR login to be restricted to QQ Music');

const root = await call('/');
assert(root.status === 302, `Expected the bare domain to redirect to /login, got ${root.status}`);

const loginPage = await call('/login');
assert(loginPage.status === 200, `Expected /login to return 200, got ${loginPage.status}`);
assert(String(loginPage.body).includes('QQ Music Worker Login'), 'Expected /login to render the Worker login page');

const protectedQr = await worker.fetch(
  new Request('https://music.local/login/qr?server=tencent'),
  { ...env, MUSIC_ADMIN_TOKEN: 'test-admin-token' },
  ctx,
);
assert(protectedQr.status === 403, `Expected protected QR login to return 403, got ${protectedQr.status}`);

const cover = await call('/?server=tencent&type=pic&id=000MkMni19ClKG');
assert(cover.status === 200, `Expected cover smoke test to return 200, got ${cover.status}`);
assert(cover.body?.url?.startsWith('https://'), 'Expected cover smoke test to return a cover URL');

const playlist = await call('/?server=tencent&type=playlist&id=9206816111&limit=1');
assert(playlist.status === 200, `Expected playlist smoke test to return 200, got ${playlist.status}`);
assert(Array.isArray(playlist.body), 'Expected playlist smoke test to return a song array');
assert(playlist.body[0]?.url?.startsWith('https://'), 'Expected playlist song to include a playable URL endpoint');
assert(playlist.body[0]?.url?.includes('type=url'), 'Expected playlist song URL to defer audio resolution through Meting');
assert(playlist.body[0]?.url?.startsWith('https://music.local/'), 'Expected audio resolution to stay on this Worker');
assert(!playlist.body[0]?.url?.includes('injahow.cn'), 'Expected no dependency on the third-party Meting API');
assert(playlist.body[0]?.cover?.startsWith('https://y.gtimg.cn/'), 'Expected Tencent covers to use the image CDN');
assert(playlist.body.length === 1, `Expected limit=1 playlist smoke test to return 1 song, got ${playlist.body.length}`);

const resolverUrl = new URL(playlist.body[0].url);
const anonymousResolver = await call(`${resolverUrl.pathname}${resolverUrl.search}`);
assert(
  anonymousResolver.status === 200 || anonymousResolver.status === 401,
  `Expected anonymous audio resolution to succeed or require login, got ${anonymousResolver.status}`,
);
if (anonymousResolver.status === 200) {
  assert(anonymousResolver.body?.url?.startsWith('https://'), 'Expected anonymous audio resolution to return a URL');
} else {
  assert(
    !String(anonymousResolver.body?.error || '').includes('injahow.cn'),
    'Expected anonymous audio resolution errors to come from this Worker',
  );
}

const fullPlaylist = await call('/?server=tencent&type=playlist&id=9206816111&limit=all');
assert(fullPlaylist.status === 200, `Expected full playlist smoke test to return 200, got ${fullPlaylist.status}`);
assert(Array.isArray(fullPlaylist.body), 'Expected full playlist smoke test to return a song array');
assert(fullPlaylist.body.length > 18, `Expected full playlist to include more than 18 songs, got ${fullPlaylist.body.length}`);
assert(
  fullPlaylist.body.every((song) => song?.url?.startsWith('https://') && song.url.includes('type=url')),
  'Expected every full playlist song to include a playable URL endpoint',
);

const invalid = await call('/?server=bad&type=playlist&id=1');
assert(invalid.status === 400, `Expected invalid server to return 400, got ${invalid.status}`);
assert(String(invalid.body?.error || '').includes('Unsupported music server'), 'Expected invalid server error message');

const missingQrCheck = await call('/login/qr/check?server=tencent');
assert(missingQrCheck.status === 400, `Expected missing QR state to return 400, got ${missingQrCheck.status}`);

const anonymousSession = await call('/session/status?server=tencent');
assert(anonymousSession.status === 401, `Expected anonymous session status to return 401, got ${anonymousSession.status}`);

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: {
        health: health.status,
        rootRedirect: root.status,
        loginPage: loginPage.status,
        protectedQr: protectedQr.status,
        cover: cover.status,
        playlist: playlist.status,
        anonymousResolver: anonymousResolver.status,
        fullPlaylist: fullPlaylist.status,
        fullPlaylistCount: fullPlaylist.body.length,
        invalidServer: invalid.status,
        missingQrCheck: missingQrCheck.status,
        anonymousSession: anonymousSession.status,
      },
      supportedServers: health.body.supportedServers,
    },
    null,
    2,
  ),
);
