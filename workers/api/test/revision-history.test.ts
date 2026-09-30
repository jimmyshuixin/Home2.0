import { describe, expect, it, vi } from 'vitest';
import { CreationDraftSchema } from '@xvyin/contracts';
import { createApi } from '../src/app';
import { Records, type DraftRecord, type Revision } from '../src/records';
import { revisionHistoryPage } from '../src/revision-history';
import { MemoryStore } from '../src/store/memory';

const at = Date.UTC(2026, 8, 30, 4);
const draft = (title: string) => CreationDraftSchema.parse({ title });
async function versions(store: MemoryStore, total: number, id = 'entry') {
  const records = new Records(store, () => at);
  const saved: DraftRecord[] = [];
  for (let i = 0; i < total; i++) saved.push(await records.save('creations', CreationDraftSchema, draft(`版本 ${i + 1}`), 'local-test', id, i));
  return { records, saved };
}
describe('bounded private revision history', () => {
  it('pages in descending version order and remains stable while newer revisions arrive', async () => {
    const store = new MemoryStore(); const { records } = await versions(store, 13);
    const get = vi.spyOn(store, 'get'); const list = vi.spyOn(store, 'list');
    const first = await revisionHistoryPage(store, 'creations', 'entry');
    expect(first.items.map(item => item.version)).toEqual([13,12,11,10,9,8,7,6,5,4]);
    expect(get).toHaveBeenCalledTimes(11); expect(list).not.toHaveBeenCalled();
    expect(first.historyComplete).toBe(false); expect(first.items.every(item => !('data' in item) && !('authorUid' in item))).toBe(true);
    await records.save('creations', CreationDraftSchema, draft('并行保存'), 'local-test', 'entry', 13);
    const second = await revisionHistoryPage(store, 'creations', 'entry', first.nextCursor!);
    expect(second.items.map(item => item.version)).toEqual([3,2,1]); expect(second.historyComplete).toBe(true); expect(second.nextCursor).toBeNull();
  });
  it('finds pre-upgrade revisions with bounded explicit scan pages, filtering unrelated records', async () => {
    const store = new MemoryStore(); const { records, saved } = await versions(store, 4);
    await versions(store, 19, 'another');
    // Existing production records did not link to their predecessors.
    await store.transaction(async tx => {
      const existing = await tx.get<Revision>(`revisions/${saved[3]!.draftRevisionId}`);
      const { previousRevisionId: _unused, ...legacy } = existing!;
      tx.put(`revisions/${legacy.id}`, legacy);
    });
    await records.save('creations', CreationDraftSchema, draft('新版保存'), 'local-test', 'entry', 4);
    let page = await revisionHistoryPage(store, 'creations', 'entry');
    const found = [...page.items]; expect(found.map(item => item.version)).toEqual([5,4]);
    const list = vi.spyOn(store, 'list'); let pages = 0;
    while (page.nextCursor && pages++ < 10) {
      const before = list.mock.calls.length;
      page = await revisionHistoryPage(store, 'creations', 'entry', page.nextCursor);
      expect(page.scanned).toBeLessThanOrEqual(10); expect(list.mock.calls.length - before).toBe(1);
      found.push(...page.items);
    }
    expect(page.nextCursor).toBeNull(); expect(found.map(item => item.version).sort((a,b) => b-a)).toEqual([5,4,3,2,1]);
    expect(found.every(item => item.entryId === 'entry')).toBe(true);
    expect(list.mock.calls.every(call => call[1]?.limit === 10)).toBe(true);
  });
  it('rejects malformed/cross-record cursors and broken chains instead of silently truncating history', async () => {
    const store = new MemoryStore(); const { saved } = await versions(store, 12); await versions(store, 1, 'another');
    const first = await revisionHistoryPage(store, 'creations', 'entry');
    await expect(revisionHistoryPage(store, 'creations', 'another', first.nextCursor!)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(revisionHistoryPage(store, 'creations', 'entry', 'garbage')).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    const badInnerCursor = btoa(JSON.stringify({ v: 1, collection: 'creations', entryId: 'entry', mode: 'legacy', beforeVersion: 12, after: 'garbage' })).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
    await expect(revisionHistoryPage(store, 'creations', 'entry', badInnerCursor)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await store.transaction(async tx => { tx.delete(`revisions/${saved[10]!.draftRevisionId}`); });
    await expect(revisionHistoryPage(store, 'creations', 'entry')).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' });
  });
  it('restores as a new draft while preserving old revisions, publication state and media fences', async () => {
    const store = new MemoryStore(); const { records, saved } = await versions(store, 2);
    await store.transaction(async tx => {
      const record = await tx.get<DraftRecord>('creations/entry');
      tx.put('creations/entry', { ...record, visibility: 'published', lastPublishedRevisionId: saved[1]!.draftRevisionId });
      tx.put('system/public', { releaseId: 'unchanged-public-release' });
    });
    const restored = await records.restore('creations', CreationDraftSchema, 'entry', saved[0]!.draftRevisionId, 2, 'local-test');
    expect(restored).toMatchObject({ version: 3, draft: { title: '版本 1' }, visibility: 'published', lastPublishedRevisionId: saved[1]!.draftRevisionId });
    expect((await store.get<Revision>(`revisions/${restored.draftRevisionId}`))?.restoredFromRevisionId).toBe(saved[0]!.draftRevisionId);
    expect(await store.get('system/public')).toEqual({ releaseId: 'unchanged-public-release' });
    expect((await store.get<Revision>(`revisions/${saved[1]!.draftRevisionId}`))?.data).toEqual(draft('版本 2'));
    await expect(records.restore('creations', CreationDraftSchema, 'entry', saved[0]!.draftRevisionId, 2, 'local-test')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(records.restore('albums', CreationDraftSchema, 'entry', saved[0]!.draftRevisionId, 3, 'local-test')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rejects another entry revision and a legacy revision whose media was permanently deleted', async () => {
    const store = new MemoryStore(); const { records, saved } = await versions(store, 1); const other = await versions(store, 1, 'another');
    await expect(records.restore('creations', CreationDraftSchema, 'entry', other.saved[0]!.draftRevisionId, 1, 'local-test')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await store.transaction(async tx => {
      tx.put('media/missing-asset', { id: 'missing-asset', lifecycle: 'deleted' });
      tx.put('revisions/missing-media-revision', { id: 'missing-media-revision', entryId: 'entry', collection: 'creations', version: 1, authorUid: 'local-test', createdAt: new Date(at).toISOString(), data: { ...draft('历史照片'), coverAssetId: 'missing-asset' } });
    });
    await expect(records.restore('creations', CreationDraftSchema, 'entry', 'missing-media-revision', 1, 'local-test')).rejects.toMatchObject({code:'MEDIA_DELETED'});
    expect((await store.get<DraftRecord>('creations/entry'))?.draftRevisionId).toBe(saved[0]!.draftRevisionId);
  });
});

describe('revision routes use normal administrator authentication and CSRF', () => {
  it('rejects anonymous history and tokenless restore; authorized restore does not publish', async () => {
    const store = new MemoryStore(); const { saved } = await versions(store, 2);
    const origin = 'https://history-test.invalid';
    const api = createApi({ store, bucket: { get: async () => null } as unknown as R2Bucket, now: () => at, secureCookies: true, allowedOrigins: [origin], privacySalt: 'fixture-private-salt-'.repeat(3), adminUsername: 'admin', codeSha: 'a'.repeat(40), auth: { signIn: async () => ({ uid: 'admin', authTime: at/1000 }), assertSession: async () => {}, changePassword: async () => {}, requestPasswordReset: async () => {}, confirmPasswordReset: async () => ({ uid: 'admin' }), revokeAllSessions: async () => {} } });
    const path = `${origin}/api/v1/admin/creations/entry`;
    expect((await api.app.request(`${path}/revisions`)).status).toBe(401);
    const login = await api.sessions.create({ uid: 'admin', authTime: at/1000 });
    const headers = { origin, cookie: login.cookie.split(';')[0]!, 'content-type': 'application/json' };
    const history = await api.app.request(`${path}/revisions`, { headers });
    expect(history.status).toBe(200); expect(history.headers.get('cache-control')).toContain('no-store');
    expect((await history.json() as { data: Revision[] }).data.map(item => item.version)).toEqual([2,1]);
    const body = JSON.stringify({ revisionId: saved[0]!.draftRevisionId, expectedVersion: 2 });
    expect((await api.app.request(`${path}/restore`, { method: 'POST', headers, body })).status).toBe(403);
    const response = await api.app.request(`${path}/restore`, { method: 'POST', headers: { ...headers, 'x-csrf-token': login.session.csrfToken }, body });
    expect(response.status).toBe(200); expect((await response.json() as { data: DraftRecord }).data.version).toBe(3);
    expect(await store.get('system/public')).toBeNull();
  });
});
