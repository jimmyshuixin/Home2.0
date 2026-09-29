import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app';
import { sha256 } from '../src/security';
import { MemoryStore } from '../src/store/memory';
import { installStatisticsProjection } from '../src/records';

const origin = 'https://maintenance-test.invalid', now = Date.UTC(2026, 8, 29);
function fixture(store: MemoryStore) {
  return createApi({ store, bucket: { get: async () => null } as unknown as R2Bucket,
    now: () => now, secureCookies: true, allowedOrigins: [origin], privacySalt: 'isolated-local-test-salt-'.repeat(3), adminUsername: 'admin', codeSha: 'a'.repeat(40),
    auth: { signIn: async () => ({ uid: 'admin', authTime: now / 1000 }), assertSession: async () => {}, changePassword: async () => {}, requestPasswordReset: async () => {}, confirmPasswordReset: async () => ({ uid: 'admin' }), revokeAllSessions: async () => {} },
  });
}
describe('public receipt retention preserves existing business records', () => {
  it.each(['pending', 'approved', 'hidden', 'rejected'])('does not replace a %s comment after its receipt has been removed', async status => {
    const clientKey = crypto.randomUUID(), id = await sha256(`comment:${clientKey}`);
    const original = { id, nickname: 'Original', body: 'Original body', targetType: 'guestbook', targetId: null, status, version: 7, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' };
    const store = new MemoryStore({ [`comments/${id}`]: original });
    if (status === 'approved') await store.transaction(async tx => tx.put(`public_comments/${id}`, original));
    await installStatisticsProjection(store, { creations: 0, albums: 0, fitness: 0, playlists: 0, commentsPending: status === 'pending' ? 1 : 0, contacts: 0 }, null, now);
    const api = fixture(store), stats = await store.get('system/statistics');
    const response = await api.app.request(`${origin}/api/v1/comments`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'idempotency-key': clientKey }, body: JSON.stringify({ targetType: 'guestbook', nickname: 'Replacement', body: 'Must never overwrite' }) });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_EXPIRED' } });
    expect(await store.get(`comments/${id}`)).toEqual(original);
    expect(await store.get(`idempotency/${id}`)).toBeNull();
    expect(await store.get('system/statistics')).toEqual(stats);
    if (status === 'approved') expect(await store.get(`public_comments/${id}`)).toEqual(original);
  });
  it('preserves a processed private contact after its retry receipt has expired', async () => {
    const key = crypto.randomUUID(), id = await sha256(`contact:${key}`);
    const contact = { id, nickname: 'Private visitor', email: 'local-test@example.invalid', message: 'Original private message', status: 'read', version: 3 };
    const store = new MemoryStore({ [`contacts/${id}`]: contact }), api = fixture(store);
    await installStatisticsProjection(store, { creations: 0, albums: 0, fitness: 0, playlists: 0, commentsPending: 0, contacts: 1 }, null, now);
    const statistics = await store.get('system/statistics');
    const response = await api.app.request(`${origin}/api/v1/contact`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ nickname: 'Replacement', email: 'local-test@example.invalid', message: 'Must never replace the saved private message' }) });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_EXPIRED' } });
    expect(await store.get(`contacts/${id}`)).toEqual(contact);
    expect(await store.get('system/statistics')).toEqual(statistics);
  });
  it('retains ordinary concurrent retries and still rejects a different body with the same unexpired receipt', async () => {
    const key = crypto.randomUUID(), store = new MemoryStore(), api = fixture(store);
    const body = { targetType: 'guestbook', nickname: 'Visitor', body: 'One submission' };
    const send = (payload = body) => api.app.request(`${origin}/api/v1/comments`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(payload) });
    const responses = await Promise.all([send(), send()]);
    expect(responses.map(response => response.status)).toEqual([202, 202]);
    const envelopes = await Promise.all(responses.map(response => response.json()));
    expect(envelopes[0]).toMatchObject({ data: (envelopes[1] as { data: unknown }).data });
    expect((await store.list('comments')).items).toHaveLength(1);
    expect((await send({ ...body, body: 'Different' })).status).toBe(409);
  });
});
