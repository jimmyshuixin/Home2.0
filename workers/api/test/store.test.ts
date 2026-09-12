import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MemoryStore } from '../src/store/memory';
import { SqliteStore } from '../src/store/sqlite';
import { serializeJson, StoreError, type Store, type Transaction } from '../src/store/types';
import { canReserveMediaBytes } from '@xvyin/contracts';

function cleanTestDirectory(directory: string): void {
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('xvyin-store-test-')) throw new Error('Refusing to remove an unexpected directory');
  rmSync(target, { recursive: true, force: true });
}

describe.each(['memory', 'sqlite'] as const)('%s Store semantic contract', kind => {
  let store: Store;
  let close: () => Promise<void>;
  beforeEach(() => {
    if (kind === 'memory') { store = new MemoryStore(); close = async () => {}; }
    else {
      const directory = mkdtempSync(join(tmpdir(), 'xvyin-store-test-'));
      const sqlite = new SqliteStore(join(directory, 'records.sqlite'));
      store = sqlite; close = async () => { await sqlite.close(); cleanTestDirectory(directory); };
    }
  });
  afterEach(async () => { await close(); });

  it('commits multiple writes together and rolls back all of them if the callback fails', async () => {
    await expect(store.transaction(async tx => { tx.put('entries/a', { value: 1 }); tx.put('entries/b', { value: 2 }); throw new Error('business failure'); })).rejects.toThrow('business failure');
    expect(await store.get('entries/a')).toBeNull();
    expect(await store.get('entries/b')).toBeNull();
    await store.transaction(async tx => { tx.put('entries/a', { value: 1 }); tx.put('entries/b', { value: 2 }); });
    expect(await store.get('entries/a')).toEqual({ value: 1 });
    expect(await store.get('entries/b')).toEqual({ value: 2 });
  });

  it('provides detached values so mutating an input or read cannot mutate persisted state', async () => {
    const value = { nested: { count: 1 } };
    await store.transaction(async tx => { tx.put('entries/a', value); value.nested.count = 2; });
    const first = await store.get<typeof value>('entries/a'); first!.nested.count = 3;
    expect(await store.get('entries/a')).toEqual({ nested: { count: 1 } });
  });

  it('batch-reads in caller order, preserves missing/duplicate slots and detaches duplicate values', async () => {
    await store.transaction(async tx => { tx.put('entries/a', { count: 1 }); tx.put('other/b', { count: 2 }); });
    const values = await store.getMany<{ count: number }>(['other/b', 'entries/missing', 'entries/a', 'entries/a']);
    expect(values).toEqual([{ count: 2 }, null, { count: 1 }, { count: 1 }]);
    values[2]!.count = 90;
    expect(values[3]).toEqual({ count: 1 });
    expect(await store.get('entries/a')).toEqual({ count: 1 });
    expect(await store.getMany([])).toEqual([]);
    expect(await store.getMany(Array(100).fill('entries/a'))).toHaveLength(100);
    await expect(store.getMany(Array(101).fill('entries/a'))).rejects.toMatchObject({ code: 'STORE_INVALID_KEY' });
    await expect(store.getMany(['entries/a', '../secret'])).rejects.toMatchObject({ code: 'STORE_INVALID_KEY' });
    await expect(store.getMany(new Array<string>(3))).rejects.toMatchObject({ code: 'STORE_INVALID_KEY' });
  });

  it('enforces read-before-write even for outstanding unawaited reads', async () => {
    await expect(store.transaction(async tx => { tx.put('entries/a', { v: 1 }); await tx.get('entries/b'); })).rejects.toMatchObject({ code: 'STORE_TRANSACTION_ORDER' });
    expect(await store.get('entries/a')).toBeNull();
    await store.transaction(async tx => {
      const reading = tx.get('entries/a');
      expect(() => tx.put('entries/b', {})).toThrowError(expect.objectContaining({ code: 'STORE_TRANSACTION_ORDER' }));
      await reading;
    });
  });

  it('invalidates the transaction handle after its callback completes', async () => {
    let captured: Transaction | undefined;
    await store.transaction(async tx => { captured = tx; tx.put('entries/a', { v: 1 }); });
    expect(() => captured!.put('entries/a', { v: 2 })).toThrowError(expect.objectContaining({ code: 'STORE_TRANSACTION_CLOSED' }));
    expect(await store.get('entries/a')).toEqual({ v: 1 });
  });

  it('admits only one simultaneous reservation when the other would exceed 10 GB', async () => {
    await store.transaction(async tx => { tx.put('quotas/media', { used: 9_000_000_000, reserved: 0 }); });
    const reserve = () => store.transaction(async tx => {
      const quota = await tx.get<{ used: number; reserved: number }>('quotas/media');
      await new Promise<void>(resolveWait => setTimeout(resolveWait, 5));
      if (!canReserveMediaBytes(quota!.used, quota!.reserved, 512_000_000)) return false;
      tx.put('quotas/media', { ...quota!, reserved: quota!.reserved + 512_000_000 }); return true;
    });
    expect(await Promise.all([reserve(), reserve()])).toEqual([true, false]);
    expect(await store.get('quotas/media')).toEqual({ used: 9_000_000_000, reserved: 512_000_000 });
  });

  it('lets optimistic version checks reject a stale editor rather than silently overwrite', async () => {
    await store.transaction(async tx => { tx.put('entries/a', { version: 1, title: 'old' }); });
    const update = (title: string) => store.transaction(async tx => {
      const existing = await tx.get<{ version: number }>('entries/a');
      if (existing!.version !== 1) throw new StoreError('STORE_CONFLICT');
      tx.put('entries/a', { version: 2, title });
    });
    const results = await Promise.allSettled([update('first'), update('second')]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(await store.get('entries/a')).toEqual({ version: 2, title: 'first' });
  });

  it('paginates in stable ID order with collection-scoped validated cursors', async () => {
    await store.transaction(async tx => { for (const id of ['z', 'a', 'A', 'b']) tx.put(`entries/${id}`, { id }); });
    const first = await store.list('entries', { limit: 2 });
    expect(first.items.map(item => item.id)).toEqual(['A', 'a']);
    const second = await store.list('entries', { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map(item => item.id)).toEqual(['b', 'z']);
    expect(second.nextCursor).toBeNull();
    expect(() => store.list('other', { cursor: first.nextCursor! })).toThrow(StoreError);
    expect(() => store.list('entries', { limit: 51 })).toThrow(StoreError);
    expect(() => store.get('entries/../secret')).toThrow(StoreError);
  });
});

describe('SQLite persistence', () => {
  it('persists across closing/reopening and serializes two connections to the same file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'xvyin-store-test-'));
    const file = join(directory, 'records.sqlite');
    let first = new SqliteStore(file);
    let second: SqliteStore | undefined;
    try {
      await first.transaction(async tx => { tx.put('settings/fitness', { startDate: null, timezone: 'Asia/Shanghai' }); tx.put('counter/main', { value: 0 }); });
      await first.close(); first = new SqliteStore(file);
      expect(await first.get('settings/fitness')).toEqual({ startDate: null, timezone: 'Asia/Shanghai' });
      second = new SqliteStore(file);
      const increment = (connection: Store) => connection.transaction(async tx => {
        const value = await tx.get<{ value: number }>('counter/main');
        await new Promise<void>(resolveWait => setTimeout(resolveWait, 5));
        tx.put('counter/main', { value: value!.value + 1 });
      });
      await Promise.all([increment(first), increment(second)]);
      expect(await first.get('counter/main')).toEqual({ value: 2 });
    } finally { await second?.close(); await first.close(); cleanTestDirectory(directory); }
  });
});

describe('lossless JSON boundary', () => {
  it.each([undefined, NaN, Infinity, -0, 2 ** 53, BigInt(1), new Date(), new Map(), { missing: undefined }, [undefined], Array(2), '\ud800'])('rejects non-JSON or lossy value %#', value => {
    expect(() => serializeJson(value)).toThrowError(expect.objectContaining({ code: 'STORE_INVALID_VALUE' }));
  });
  it('rejects cycles and getters without executing the getter', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => serializeJson(cyclic)).toThrow(StoreError);
    let invoked = false;
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { invoked = true; return 1; } });
    expect(() => serializeJson(accessor)).toThrow(StoreError);
    expect(invoked).toBe(false);
  });
});
