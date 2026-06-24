const SESSION_KEY = 'qq-music-session';

export class MusicSessionStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== '/session') {
      return jsonResponse({ error: 'Not found' }, 404);
    }

    if (request.method === 'GET') {
      return await this.getSession(url.searchParams.get('id') || '');
    }

    if (request.method === 'PUT') {
      return await this.putSession(await request.json());
    }

    if (request.method === 'DELETE') {
      return await this.deleteSession(url.searchParams.get('id') || '');
    }

    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  async alarm() {
    const session = await this.ctx.storage.get(SESSION_KEY);
    if (!session || Date.now() >= Number(session.expiresAt)) {
      await this.ctx.storage.delete(SESSION_KEY);
      return;
    }

    await this.ctx.storage.setAlarm(Number(session.expiresAt));
  }

  async getSession(expectedId) {
    const session = await this.ctx.storage.get(SESSION_KEY);

    if (!session || Date.now() >= Number(session.expiresAt)) {
      await this.ctx.storage.delete(SESSION_KEY);
      await this.deleteAlarm();
      return jsonResponse({ session: null }, 404);
    }

    if (expectedId && session.id !== expectedId) {
      return jsonResponse({ session: null }, 404);
    }

    return jsonResponse({ session }, 200);
  }

  async putSession(value) {
    const session = normalizeSession(value);
    if (!session) {
      return jsonResponse({ error: 'Invalid session payload' }, 400);
    }

    await this.ctx.storage.put(SESSION_KEY, session);
    await this.ctx.storage.setAlarm(session.expiresAt);
    return jsonResponse({ ok: true }, 200);
  }

  async deleteSession(expectedId) {
    const session = await this.ctx.storage.get(SESSION_KEY);
    if (session && expectedId && session.id !== expectedId) {
      return jsonResponse({ ok: false }, 404);
    }

    await this.ctx.storage.delete(SESSION_KEY);
    await this.deleteAlarm();
    return jsonResponse({ ok: true }, 200);
  }

  async deleteAlarm() {
    if (typeof this.ctx.storage.deleteAlarm === 'function') {
      await this.ctx.storage.deleteAlarm();
    }
  }
}

function normalizeSession(value) {
  const session = value && typeof value === 'object' ? value : null;
  const expiresAt = Number(session?.expiresAt);

  if (!session?.id || session.server !== 'tencent' || !session.cookie || !Number.isFinite(expiresAt)) {
    return null;
  }

  return {
    id: String(session.id),
    server: 'tencent',
    cookie: String(session.cookie),
    expiresAt,
    createdAt: Number(session.createdAt) || Date.now(),
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
