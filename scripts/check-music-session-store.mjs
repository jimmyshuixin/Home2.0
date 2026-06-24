import assert from 'node:assert/strict';
import { MusicSessionStore } from '../worker/music-session-store.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.alarm = null;
  }

  async get(key) {
    return this.values.get(key);
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
  }

  async setAlarm(value) {
    this.alarm = value;
  }

  async deleteAlarm() {
    this.alarm = null;
  }
}

const storage = new MemoryStorage();
const store = new MusicSessionStore({ storage }, {});
const expiresAt = Date.now() + 60_000;
const session = {
  id: 'session-test',
  server: 'tencent',
  cookie: 'qqmusic_uin=123; qqmusic_key=test',
  expiresAt,
  createdAt: Date.now(),
};

const put = await store.fetch(
  new Request('https://session.local/session', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(session),
  }),
);
assert.equal(put.status, 200);
assert.equal(storage.alarm, expiresAt);

const get = await store.fetch(new Request('https://session.local/session?id=session-test'));
assert.equal(get.status, 200);
assert.deepEqual((await get.json()).session, session);

const mismatch = await store.fetch(new Request('https://session.local/session?id=other-session'));
assert.equal(mismatch.status, 404);

const remove = await store.fetch(
  new Request('https://session.local/session?id=session-test', { method: 'DELETE' }),
);
assert.equal(remove.status, 200);
assert.equal(storage.alarm, null);

const missing = await store.fetch(new Request('https://session.local/session'));
assert.equal(missing.status, 404);

console.log('Music session store unit test passed');
