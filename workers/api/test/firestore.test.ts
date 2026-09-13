import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirestoreStore, type FirestoreConfig } from '../src/store/firestore';
import { UnconfiguredStore } from '../src/store/unconfigured';
import { mediaSortValue } from '../src/store/media-query';

const config: FirestoreConfig = { projectId: 'xvyin-contract-test', databaseId: '(default)', edition: 'standard' };
const parent = 'projects/xvyin-contract-test/databases/(default)/documents';
const time = '2026-09-12T00:00:00.000000Z';
function doc(id: string, value: unknown) {
  return { name: `${parent}/v3_entries/${id}`, fields: { schema_version: { integerValue: '1' }, record_json: { stringValue: JSON.stringify(value) } } };
}
function body(init?: RequestInit): Record<string, unknown> { return JSON.parse(String(init?.body)) as Record<string, unknown>; }
function operation(url: RequestInfo | URL): string { return String(url).split(':').at(-1)!; }
const access = async () => 'fake-test-token';
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('Firestore REST protocol without remote access', () => {
  it('queries the media catalog with one single-field ordered request and resumes its exact stable cursor', async () => {
    const rows = ['a', 'b', 'c'].map(id => ({ id, kind: 'image', originalName: '同名.jpg', originalBytes: 10, createdAt: '2026-09-13T00:00:00.000Z', variants: [] }));
    const requests: Record<string, unknown>[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const request = body(init); requests.push(request);
      const query = request.structuredQuery as { orderBy: unknown[]; startAt?: { values: { stringValue: string }[] }; limit: number };
      const after = query.startAt?.values[0]?.stringValue || '';
      expect(query.orderBy).toEqual([{ field: { fieldPath: 'sort_name' }, direction: 'ASCENDING' }]);
      expect(request).not.toHaveProperty('where');
      return Response.json(rows.filter(row => mediaSortValue(row, 'name') > after).slice(0, query.limit).map(row => ({ document: { name: `${parent}/v3_media_catalog/${row.id}`, fields: { schema_version: { integerValue: '1' }, record_json: { stringValue: JSON.stringify(row) } } }, readTime: time })));
    });
    const store = new FirestoreStore(config, { getAccessToken: access, fetch: fetcher });
    const first = await store.queryMedia({ sort: 'name', direction: 'asc', limit: 2 }); expect(first.items.map(row => row.id)).toEqual(['a', 'b']); expect(requests).toHaveLength(1);
    const second = await store.queryMedia({ sort: 'name', direction: 'asc', limit: 2, cursor: first.nextCursor! }); expect(second.items.map(row => row.id)).toEqual(['c']); expect(second.nextCursor).toBeNull(); expect(requests).toHaveLength(2);
  });
  it('writes the media record, native single-field catalog keys and verified hash mapping in one commit', async () => {
    const commits: Record<string, unknown>[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (operation(url) === 'beginTransaction') return Response.json({ transaction: 'test-transaction' });
      const request = body(init); commits.push(request);
      return Response.json({ writeResults: (request.writes as unknown[]).map(() => ({})), commitTime: time });
    });
    const store = new FirestoreStore(config, { getAccessToken: access, fetch: fetcher }), value = { id: 'photo', kind: 'image', originalName: '照片.jpg', originalBytes: 30, variants: [], status: 'ready', createdAt: '2026-09-13T00:00:00.000Z', metadata: { sha256: 'b'.repeat(64) } };
    await store.transaction(async tx => { tx.put('media/photo', value); });
    const writes = commits[0]!.writes as { update: { name: string; fields: Record<string, { stringValue: string }> } }[];
    expect(writes).toHaveLength(3); expect(writes[1]!.update.name).toBe(`${parent}/v3_media_catalog/photo`);
    for (const sort of ['created', 'name', 'size'] as const) expect(writes[1]!.update.fields[`sort_${sort}`]?.stringValue).toBe(mediaSortValue(value, sort));
    expect(writes[2]!.update.name).toBe(`${parent}/v3_media_hashes/${'b'.repeat(64)}`);
  });
  it('rejects redirected document requests without forwarding the bearer token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 307, headers: { Location: 'https://untrusted.invalid/documents' } }));
    await expect(new FirestoreStore(config, { getAccessToken: access, fetch: fetcher }).get('entries/test')).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });
  it('logs fixed operation and HTTP status without provider body, record name or bearer token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: 'private-provider-error' } }, { status: 403 }));
    const store = new FirestoreStore(config, { getAccessToken: access, fetch: fetcher });
    await expect(store.get('entries/private-record')).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(JSON.parse(String(vi.mocked(console.error).mock.calls[0]?.[0]))).toEqual({ level: 'error', code: 'FIRESTORE_REQUEST_FAILED', operation: 'batchGet', stage: 'response_status', status: 403, exceptionName: 'UnknownError' });
    const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
    for (const value of ['private-provider-error', 'private-record', 'fake-test-token', config.projectId]) expect(logs).not.toContain(value);
  });

  it('distinguishes access-token and transport failures without forwarding exception detail', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const failure = new TypeError('private-transport-detail');
    const store = new FirestoreStore(config, { getAccessToken: async () => { throw failure; }, fetch: fetcher });
    await expect(store.get('entries/private-record')).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(String(vi.mocked(console.error).mock.calls[0]?.[0]))).toMatchObject({ operation: 'batchGet', stage: 'access_token', status: null, exceptionName: 'TypeError' });
    failure.name = 'secret-untrusted-name'; fetcher.mockRejectedValueOnce(failure);
    await expect(new FirestoreStore(config, { getAccessToken: access, fetch: fetcher }).get('entries/private-record')).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(JSON.parse(String(vi.mocked(console.error).mock.calls[1]?.[0]))).toEqual({ level: 'error', code: 'FIRESTORE_REQUEST_FAILED', operation: 'batchGet', stage: 'fetch', status: null, exceptionName: 'UnknownError' });
    const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
    for (const value of [failure.message, failure.name, 'private-record', 'fake-test-token']) expect(logs).not.toContain(value);
  });

  it('uses one batchGet for 100 keys and reorders shuffled provider results with missing and duplicate slots', async () => {
    const keys = [...Array.from({ length: 98 }, (_, index) => `entries/a${index}`), 'entries/missing', 'entries/a0'];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(operation(url)).toBe('batchGet');
      const names = body(init).documents as string[];
      expect(names).toHaveLength(99);
      return Response.json(names.map(name => name.endsWith('/missing') ? { missing: name, readTime: time } : { found: doc(name.split('/').at(-1)!, { name }), readTime: time }).reverse());
    });
    const store = new FirestoreStore(config, { getAccessToken: access, fetch: fetcher });
    const result = await store.getMany<{ name: string }>(keys);
    expect(result).toHaveLength(100); expect(result[98]).toBeNull();
    expect(result[0]).toEqual({ name: `${parent}/v3_entries/a0` });
    expect(result[97]).toEqual({ name: `${parent}/v3_entries/a97` });
    result[0]!.name = 'changed'; expect(result[99]!.name).toBe(`${parent}/v3_entries/a0`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid/oversized batches before token or network activity and keeps unconfigured storage closed', async () => {
    const fetcher = vi.fn<typeof fetch>(), token = vi.fn(access);
    const store = new FirestoreStore(config, { getAccessToken: token, fetch: fetcher });
    expect(await store.getMany([])).toEqual([]);
    await expect(store.getMany(Array(101).fill('entries/a'))).rejects.toMatchObject({ code: 'STORE_INVALID_KEY' });
    await expect(store.getMany(['entries/a', 'entries/../secrets'])).rejects.toMatchObject({ code: 'STORE_INVALID_KEY' });
    await expect(store.getMany(new Array<string>(2))).rejects.toMatchObject({ code: 'STORE_INVALID_KEY' });
    expect(fetcher).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled();
    await expect(new UnconfiguredStore().getMany()).rejects.toMatchObject({ code: 'STORE_NOT_CONFIGURED' });
  });

  it.each([
    [{ found: doc('a', {}) }],
    [{ found: doc('a', {}) }, { found: doc('a', {}) }],
    [{ found: doc('a', {}) }, { found: { ...doc('b', {}), name: `${parent}/legacy/b` } }],
    [{ found: doc('a', {}), missing: `${parent}/v3_entries/a` }, { found: doc('b', {}) }],
    [{ found: doc('a', {}) }, { found: doc('b', {}) }, null],
  ])('refuses malformed, duplicate, incomplete or cross-namespace batch response %#', async (...rows) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(rows));
    const store = new FirestoreStore(config, { getAccessToken: access, fetch: fetcher });
    await expect(store.getMany(['entries/a', 'entries/b'])).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads only v3_ records and distinguishes a missing document from provider errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(String(url)).toBe(`https://firestore.googleapis.com/v1/${parent}:batchGet`);
      expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fake-test-token');
      expect(body(init).documents).toEqual([`${parent}/v3_entries/a`]);
      return Response.json([{ found: doc('a', { version: 2 }), readTime: time }]);
    });
    const store = new FirestoreStore(config, { getAccessToken: access, fetch: fetcher });
    expect(await store.get('entries/a')).toEqual({ version: 2 });
    fetcher.mockResolvedValueOnce(Response.json([{ missing: `${parent}/v3_entries/a`, readTime: time }]));
    expect(await store.get('entries/a')).toBeNull();
    fetcher.mockResolvedValueOnce(Response.json({ error: { message: 'sensitive-provider-detail' } }, { status: 403 }));
    await expect(store.get('entries/a')).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', message: '数据服务暂时不可用' });
  });

  it('retries only explicit transaction ABORTED, using fresh reads and the retry transaction identifier', async () => {
    let attempt = 0; const writes: unknown[] = []; const observed: number[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const request = body(init);
      switch (operation(url)) {
        case 'beginTransaction':
          attempt++;
          if (attempt === 2) expect(request).toEqual({ options: { readWrite: { retryTransaction: 'dHgx' } } });
          return Response.json({ transaction: btoa(`tx${attempt}`) });
        case 'batchGet':
          expect(request.transaction).toBe(btoa(`tx${attempt}`));
          return Response.json([{ found: doc('a', { version: attempt }), readTime: time }]);
        case 'commit':
          writes.push(request.writes);
          return attempt === 1 ? Response.json({ error: { status: 'ABORTED', message: 'contention' } }, { status: 409 }) : Response.json({ writeResults: [{ updateTime: time }], commitTime: time });
        case 'rollback': return Response.json({});
        default: throw new Error('Unexpected operation');
      }
    });
    const store = new FirestoreStore(config, { getAccessToken: access, fetch: fetcher });
    const result = await store.transaction(async tx => {
      const existing = await tx.get<{ version: number }>('entries/a'); observed.push(existing!.version);
      tx.put('entries/a', { version: existing!.version + 1 }); return existing!.version + 1;
    });
    expect(observed).toEqual([1, 2]); expect(result).toBe(3); expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual([{ update: doc('a', { version: 3 }) }]);
  });

  it('does not repeat an ambiguous commit after the transport fails', async () => {
    const operations: string[] = []; const callback = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const method = operation(url); operations.push(method);
      if (method === 'beginTransaction') return Response.json({ transaction: 'dHg=' });
      if (method === 'commit') throw new TypeError('network unavailable after send');
      if (method === 'rollback') return Response.json({});
      throw new Error('Unexpected request');
    });
    const store = new FirestoreStore(config, { getAccessToken: access, fetch: fetcher });
    await expect(store.transaction(async tx => { callback(); tx.put('entries/a', { version: 1 }); })).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(operations).toEqual(['beginTransaction', 'commit', 'rollback']);
  });

  it('rolls back on a business error without ever sending partial buffered writes', async () => {
    const operations: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
      const method = operation(url); operations.push(method);
      return Response.json(method === 'beginTransaction' ? { transaction: 'dHg=' } : {});
    });
    const store = new FirestoreStore(config, { getAccessToken: access, fetch: fetcher });
    await expect(store.transaction(async tx => { tx.put('entries/a', { version: 1 }); throw new Error('version mismatch'); })).rejects.toThrow('version mismatch');
    expect(operations).toEqual(['beginTransaction', 'rollback']);
  });

  it('treats a malformed successful commit acknowledgement as ambiguous and does not replay writes', async () => {
    const operations: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
      const method = operation(url); operations.push(method);
      return Response.json(method === 'beginTransaction' ? { transaction: 'dHg=' } : {});
    });
    const store = new FirestoreStore(config, { getAccessToken: access, fetch: fetcher });
    await expect(store.transaction(async tx => { tx.put('entries/a', { version: 1 }); })).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(operations).toEqual(['beginTransaction', 'commit', 'rollback']);
  });

  it('accepts a read-only transaction acknowledgement when protobuf JSON omits the empty writeResults array', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
      switch (operation(url)) {
        case 'beginTransaction': return Response.json({ transaction: 'dHg=' });
        case 'batchGet': return Response.json([{ found: doc('a', { epoch: 1 }), readTime: time }]);
        case 'commit': return Response.json({ commitTime: time });
        default: throw new Error('Unexpected request');
      }
    });
    const store = new FirestoreStore(config, { getAccessToken: access, fetch: fetcher });
    expect(await store.transaction(tx => tx.get('entries/a'))).toEqual({ epoch: 1 });
  });

  it('rejects reading after writes, with no commit or further remote read', async () => {
    const operations: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => { const method = operation(url); operations.push(method); return Response.json(method === 'beginTransaction' ? { transaction: 'dHg=' } : {}); });
    const store = new FirestoreStore(config, { getAccessToken: access, fetch: fetcher });
    await expect(store.transaction(async tx => { tx.put('entries/a', {}); await tx.get('entries/b'); })).rejects.toMatchObject({ code: 'STORE_TRANSACTION_ORDER' });
    expect(operations).toEqual(['beginTransaction', 'rollback']);
  });

  it('queries bounded batches and keeps the same readTime while assembling one page', async () => {
    const all = Array.from({ length: 7 }, (_, index) => String(index + 1).padStart(2, '0'));
    const requests: Record<string, unknown>[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(operation(url)).toBe('runQuery');
      const request = body(init); requests.push(request);
      const query = request.structuredQuery as { limit: number; from: unknown; startAt?: { values: { referenceValue: string }[]; before: boolean } };
      expect(query.from).toEqual([{ collectionId: 'v3_entries' }]); expect(query.limit).toBeLessThanOrEqual(5);
      const after = query.startAt?.values[0]?.referenceValue.split('/').at(-1) ?? '';
      if (query.startAt) expect(query.startAt.before).toBe(false);
      const rows = all.filter(id => id > after).slice(0, query.limit).map(id => ({ document: doc(id, { id }), readTime: time }));
      return Response.json(rows.length ? rows : [{ readTime: time }]);
    });
    const store = new FirestoreStore(config, { getAccessToken: access, fetch: fetcher });
    const page = await store.list('entries', { limit: 5 });
    expect(page.items.map(item => item.id)).toEqual(['01', '02', '03', '04', '05']);
    expect(requests).toHaveLength(2); expect(requests[1]!.readTime).toBe(time);
    const next = await store.list('entries', { limit: 5, cursor: page.nextCursor! });
    expect(next.items.map(item => item.id)).toEqual(['06', '07']); expect(next.nextCursor).toBeNull();
  });

  it('refuses legacy/malformed documents, missing configuration and unapproved namespace changes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{ found: { name: `${parent}/guestbook/a`, fields: { body: { stringValue: 'legacy' } } } }]));
    const store = new FirestoreStore(config, { getAccessToken: access, fetch: fetcher });
    await expect(store.get('entries/a')).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect(() => new FirestoreStore({ ...config, collectionPrefix: '' }, { getAccessToken: access })).toThrowError(expect.objectContaining({ code: 'STORE_NOT_CONFIGURED' }));
    expect(() => new FirestoreStore({ ...config, edition: 'enterprise' as 'standard' }, { getAccessToken: access })).toThrowError(expect.objectContaining({ code: 'STORE_NOT_CONFIGURED' }));
    expect(() => new FirestoreStore({ ...config, databaseId: '' }, { getAccessToken: access })).toThrowError(expect.objectContaining({ code: 'STORE_NOT_CONFIGURED' }));
  });
});
