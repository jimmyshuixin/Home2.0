import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/store/memory';
import { SqliteStore } from '../src/store/sqlite';
import { FirestoreStore } from '../src/store/firestore';
import type { ExpiryCollection } from '../src/store/expiry-query';
import type { Transaction } from '../src/store/types';

describe.each(['memory', 'sqlite'] as const)('%s expiry projection and transaction batch reads', kind => {
  it('indexes only valid whitelisted expiry atomically and removes expired-index entries on renewal, invalidation and deletion', async () => {
    const store = kind === 'memory' ? new MemoryStore() : new SqliteStore(':memory:');
    try {
      await store.transaction(async tx => {
        for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) tx.put(`sessions/${id}`, { expiresAt: 100 });
        tx.put('sessions/future', { expiresAt: 101 });
        for (const [id, expiresAt] of [['zero', 0], ['negative', -1], ['fraction', 1.5], ['string', '100'], ['null', null], ['tooFar', 8_640_000_000_000_001]]) tx.put(`sessions/${id}`, { expiresAt });
        tx.put('uploads/keep', { expiresAt: 10 });
      });
      expect(await store.queryExpired('sessions', { expiresBefore: 100 })).toEqual({ items: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, expiresAt: 100 })), hasMore: true });
      await expect(store.transaction(async tx => { tx.put('sessions/rollback', { expiresAt: 1 }); throw new Error('rollback'); })).rejects.toThrow('rollback');
      await store.transaction(async tx => { tx.put('sessions/a', { expiresAt: 200 }); tx.put('sessions/b', { expiresAt: 'invalid' }); tx.delete('sessions/c'); });
      expect((await store.queryExpired('sessions', { expiresBefore: 100 })).items.map(row => row.id)).toEqual(['d', 'e', 'f']);
      expect(() => store.queryExpired('uploads' as ExpiryCollection, { expiresBefore: 100 })).toThrow();
      expect(() => store.queryExpired('sessions', { expiresBefore: 100, limit: 6 })).toThrow();
    } finally { if (store instanceof SqliteStore) await store.close(); }
  });

  it('batch reads preserve duplicate slots, snapshot isolation, bounded keys, read-before-write and closed handles', async () => {
    const store = kind === 'memory' ? new MemoryStore() : new SqliteStore(':memory:');
    try {
      await store.transaction(async tx => { tx.put('sessions/a', { expiresAt: 1 }); });
      let captured: Transaction | undefined;
      await store.transaction(async tx => {
        captured = tx;
        const pending = tx.getMany<{ expiresAt: number }>(['sessions/a', 'sessions/missing', 'sessions/a']);
        expect(() => tx.put('sessions/a', { expiresAt: 2 })).toThrowError(expect.objectContaining({ code: 'STORE_TRANSACTION_ORDER' }));
        const rows = await pending;
        expect(rows).toEqual([{ expiresAt: 1 }, null, { expiresAt: 1 }]); rows[0]!.expiresAt = 90; expect(rows[2]).toEqual({ expiresAt: 1 });
        expect(await tx.getMany([])).toEqual([]);
        await expect(tx.getMany(Array(101).fill('sessions/a'))).rejects.toMatchObject({ code: 'STORE_INVALID_KEY' });
        await expect(tx.getMany(new Array<string>(2))).rejects.toMatchObject({ code: 'STORE_INVALID_KEY' });
        tx.put('sessions/a', { expiresAt: 2 });
        await expect(tx.getMany(['sessions/a'])).rejects.toMatchObject({ code: 'STORE_TRANSACTION_ORDER' });
      });
      await expect(captured!.getMany(['sessions/a'])).rejects.toMatchObject({ code: 'STORE_TRANSACTION_CLOSED' });
      expect(await store.get('sessions/a')).toEqual({ expiresAt: 2 });
    } finally { if (store instanceof SqliteStore) await store.close(); }
  });
});

const parent = 'projects/xvyin-contract-test/databases/(default)/documents';
const config = { projectId: 'xvyin-contract-test', databaseId: '(default)', edition: 'standard' } as const;
const at = '2026-09-29T00:00:00.000Z';
function expiryDoc(id: string, expiry = 100) { return { name: `${parent}/v3_sessions/${id}`, fields: { expires_at: { integerValue: String(expiry) } } }; }

describe('Firestore expiry REST protocol without remote access', () => {
  it('performs one bounded single-field query selecting only expiry, with no payload or composite-index request', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url).split(':').at(-1)).toBe('runQuery');
      expect(JSON.parse(String(init?.body))).toEqual({ structuredQuery: {
        select: { fields: [{ fieldPath: 'expires_at' }] }, from: [{ collectionId: 'v3_sessions' }],
        where: { fieldFilter: { field: { fieldPath: 'expires_at' }, op: 'LESS_THAN_OR_EQUAL', value: { integerValue: '100' } } },
        orderBy: [{ field: { fieldPath: 'expires_at' }, direction: 'ASCENDING' }], limit: 6,
      } });
      return Response.json(['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ document: expiryDoc(id), readTime: at })));
    });
    const store = new FirestoreStore(config, { getAccessToken: async () => 'test-only-token', fetch: fetcher });
    expect(await store.queryExpired('sessions', { expiresBefore: 100 })).toEqual({ items: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, expiresAt: 100 })), hasMore: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(store.queryExpired('uploads' as ExpiryCollection, { expiresBefore: 100 })).rejects.toMatchObject({ code: 'STORE_INVALID_KEY' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['wrong-collection', 'wrong-type', 'past-limit', 'duplicate', 'reversed', 'too-many'] as const)('fails closed for malformed %s expiry responses', async mode => {
    let documents = [expiryDoc('a'), expiryDoc('b')];
    if (mode === 'wrong-collection') documents[0]!.name = `${parent}/v3_uploads/a`;
    if (mode === 'wrong-type') documents[0]!.fields.expires_at.integerValue = 'invalid';
    if (mode === 'past-limit') documents[0]!.fields.expires_at.integerValue = '101';
    if (mode === 'duplicate') documents = [documents[0]!, documents[0]!];
    if (mode === 'reversed') documents.reverse();
    if (mode === 'too-many') documents.push(expiryDoc('c'));
    const store = new FirestoreStore(config, { getAccessToken: async () => 'test-only-token', fetch: async () => Response.json(documents.map(document => ({ document, readTime: at }))) });
    await expect(store.queryExpired('sessions', { expiresBefore: 100, limit: 1 })).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
  });

  it('batch-reads six keys using the transaction token, restores duplicate slots and stores expiry in the original document only', async () => {
    const operations: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const operation = String(url).split(':').at(-1)!, body = JSON.parse(String(init?.body)); operations.push(operation);
      if (operation === 'beginTransaction') return Response.json({ transaction: 'transaction-token' });
      if (operation === 'batchGet') {
        expect(body.transaction).toBe('transaction-token'); expect(body.documents).toHaveLength(5);
        return Response.json(body.documents.map((name: string) => name.endsWith('/missing') ? { missing: name, readTime: at } : { found: { name, fields: { schema_version: { integerValue: '1' }, record_json: { stringValue: JSON.stringify({ expiresAt: 100, id: name.split('/').at(-1) }) } } }, readTime: at }).reverse());
      }
      expect(operation).toBe('commit'); expect(body.transaction).toBe('transaction-token');
      expect(body.writes).toHaveLength(4);
      expect(body.writes[0].update.fields.expires_at).toEqual({ integerValue: '200' });
      expect(body.writes[0].update.name).toBe(`${parent}/v3_sessions/a`);
      expect(body.writes[1].update.fields.expires_at).toBeUndefined();
      expect(body.writes[2].update.fields.expires_at).toBeUndefined();
      expect(body.writes[3]).toEqual({ delete: `${parent}/v3_sessions/d` });
      for (const write of body.writes) expect(write.updateMask).toBeUndefined(); // Whole replacement removes a formerly valid expiry field.
      return Response.json({ writeResults: body.writes.map(() => ({})), commitTime: at });
    });
    const store = new FirestoreStore(config, { getAccessToken: async () => 'test-only-token', fetch: fetcher });
    await store.transaction(async tx => {
      const rows = await tx.getMany<{ expiresAt: number; id: string }>(['sessions/a', 'sessions/b', 'sessions/c', 'sessions/d', 'sessions/missing', 'sessions/a']);
      expect(rows.map(row => row?.id ?? null)).toEqual(['a', 'b', 'c', 'd', null, 'a']);
      rows[0]!.expiresAt = 500; expect(rows[5]!.expiresAt).toBe(100);
      tx.put('sessions/a', { expiresAt: 200 }); tx.put('sessions/b', { expiresAt: 'invalid' }); tx.put('uploads/c', { expiresAt: 200 }); tx.delete('sessions/d');
    });
    expect(operations).toEqual(['beginTransaction', 'batchGet', 'commit']);
  });
});
