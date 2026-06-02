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
assert(Array.isArray(health.body?.supportedServers), 'Expected /health to list supported servers');

const cover = await call('/?server=tencent&type=pic&id=000MkMni19ClKG');
assert(cover.status === 200, `Expected cover smoke test to return 200, got ${cover.status}`);
assert(cover.body?.url?.startsWith('https://'), 'Expected cover smoke test to return a cover URL');

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
        cover: cover.status,
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
