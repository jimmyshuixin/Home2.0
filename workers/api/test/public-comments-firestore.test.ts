import { describe, expect, it, vi } from 'vitest';
import { FirestoreStore } from '../src/store/firestore';
import { publicCommentCatalog, publicCommentSortValue } from '../src/store/public-comment-query';

const parent = 'projects/xvyin-contract-test/databases/(default)/documents';
const target = { targetType: 'guestbook', targetId: null } as const;
const at = '2026-09-29T00:00:00.000Z';
const values = Array.from({ length: 55 }, (_, index) => ({ ...target, id: `a${String(index).padStart(3, '0')}`, status: 'approved' as const, nickname: '访客', body: '测试评论', createdAt: at }));
const makeStore = (fetcher: typeof fetch) => new FirestoreStore({ projectId: 'xvyin-contract-test', databaseId: '(default)', edition: 'standard' }, { getAccessToken: async () => 'test-only-token', fetch: fetcher });
function document(value: typeof values[number]) { return { name: `${parent}/v3_public_comment_catalog/${value.id}`, fields: { schema_version: { integerValue: '1' }, record_json: { stringValue: JSON.stringify(value) }, sort_target: { stringValue: publicCommentSortValue(value) } } }; }

describe('Firestore public-comment query protocol (no remote access)', () => {
  it('uses one single-field range request for exactly limit+1 newest matching rows', async () => {
    const calls: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(`https://firestore.googleapis.com/v1/${parent}:runQuery`);
      const request = JSON.parse(String(init?.body)); calls.push(request);
      const query = request.structuredQuery;
      expect(query.from).toEqual([{ collectionId: 'v3_public_comment_catalog' }]);
      expect(query.orderBy).toEqual([{ field: { fieldPath: 'sort_target' }, direction: 'DESCENDING' }]);
      expect(query.where).toEqual({ compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: 'sort_target' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: 'guestbook\u0001\u0001' } } },
        { fieldFilter: { field: { fieldPath: 'sort_target' }, op: 'LESS_THAN', value: { stringValue: 'guestbook\u0001\u0001\uffff' } } },
      ] } });
      expect(query.limit).toBe(13);
      if (query.startAt) expect(query.startAt.before).toBe(false);
      const after: string | undefined = query.startAt?.values[0]?.stringValue;
      return Response.json(values.filter(value => !after || publicCommentSortValue(value) < after).reverse().slice(0, query.limit).map(value => ({ document: document(value), readTime: at })));
    });
    const store = makeStore(fetcher);
    const first = await store.queryPublicComments({ ...target, limit: 12 });
    expect(first.items.map(row => row.id)).toEqual(Array.from({ length: 12 }, (_, i) => `a${String(54 - i).padStart(3, '0')}`));
    expect(calls).toHaveLength(1);
    const second = await store.queryPublicComments({ ...target, limit: 12, cursor: first.nextCursor! });
    expect(second.items[0]!.id).toBe('a042'); expect(calls).toHaveLength(2);
    await expect(store.queryPublicComments({ targetType: 'album', targetId: 'album', cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'STORE_INVALID_KEY' });
    expect(calls).toHaveLength(2);
  });

  it('commits the whitelist and its native sort field atomically with approval, and deletes both on hiding', async () => {
    const commits: { writes: { update?: { name: string; fields: Record<string, { stringValue?: string }> }; delete?: string }[] }[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const operation = String(url).split(':').at(-1);
      if (operation === 'beginTransaction') return Response.json({ transaction: 'test-transaction' });
      const body = JSON.parse(String(init?.body)); commits.push(body);
      return Response.json({ writeResults: body.writes.map(() => ({})), commitTime: at });
    });
    const store = makeStore(fetcher), value = { ...values[0]!, email: 'private@example.invalid', version: 2, updatedAt: at };
    await store.transaction(async tx => { tx.put(`public_comments/${value.id}`, value); });
    expect(commits[0]!.writes).toHaveLength(2);
    const catalog = commits[0]!.writes[1]!.update!;
    expect(catalog.name).toBe(`${parent}/v3_public_comment_catalog/a000`);
    expect(catalog.fields.sort_target).toEqual({ stringValue: 'guestbook\u0001\u00012026-09-29T00:00:00.000Z\u0001a000' });
    expect(JSON.parse(catalog.fields.record_json!.stringValue!)).toEqual(publicCommentCatalog(value, value.id));
    expect(catalog.fields.record_json!.stringValue).not.toContain('private@example.invalid');
    await store.transaction(async tx => { tx.delete(`public_comments/${value.id}`); });
    expect(commits[1]!.writes).toEqual([{ delete: `${parent}/v3_public_comments/a000` }, { delete: `${parent}/v3_public_comment_catalog/a000` }]);
  });

  it.each(['wrong-target', 'wrong-index', 'duplicate', 'reversed', 'overflow'] as const)('rejects malformed %s query responses', async mode => {
    let rows = [document(values[2]!), document(values[1]!)];
    if (mode === 'wrong-target') rows = [document({ ...values[2]!, targetType: 'album', targetId: 'album-one' } as unknown as typeof values[number])];
    if (mode === 'wrong-index') rows[0]!.fields.sort_target.stringValue = 'invalid';
    if (mode === 'duplicate') rows = [rows[0]!, rows[0]!];
    if (mode === 'reversed') rows.reverse();
    if (mode === 'overflow') rows = [document(values[3]!), document(values[2]!), document(values[1]!)];
    const store = makeStore(async () => Response.json(rows.map(value => ({ document: value, readTime: at }))));
    await expect(store.queryPublicComments({ ...target, limit: 1 })).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
  });
});
