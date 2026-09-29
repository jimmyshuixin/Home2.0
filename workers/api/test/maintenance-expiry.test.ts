import { describe, expect, it } from 'vitest';
import { ExpiryMaintenance, EXPIRY_MAINTENANCE_STATE } from '../src/maintenance-expiry';
import { MemoryStore } from '../src/store/memory';
import { SqliteStore } from '../src/store/sqlite';
import type { Store, Transaction } from '../src/store/types';
import type { ExpiredQueryOptions, ExpiredQueryPage, ExpiryCollection } from '../src/store/expiry-query';

const start = Date.parse('2026-09-29T10:00:00.000Z');
async function backfill(service: ExpiryMaintenance) {
  for (let step = 0; step < 100; step++) {
    const state = await service.getStatus();
    if (state.phase === 'cleanup') return state;
    expect(state.canAdvance).toBe(true);
    await service.advance();
  }
  throw new Error('Backfill did not finish');
}

describe.each(['memory', 'sqlite'] as const)('%s expiry maintenance', kind => {
  it('only deletes due whitelisted records, preserves invalid values and pauses after a complete empty round', async () => {
    const store = kind === 'memory' ? new MemoryStore() : new SqliteStore(':memory:');
    let now = start;
    const service = new ExpiryMaintenance(store, () => now);
    try {
      await store.transaction(async tx => {
        for (const collection of ['sessions', 'rates', 'idempotency']) {
          tx.put(`${collection}/due`, { expiresAt: now, privateValue: 'never-in-status' });
          tx.put(`${collection}/future`, { expiresAt: now + 60_000 });
          tx.put(`${collection}/invalid`, { expiresAt: 'yesterday' });
        }
        for (const collection of ['auth_epochs', 'uploads', 'upload_requests', 'release_requests', 'comments', 'contacts', 'revisions', 'releases']) tx.put(`${collection}/keep`, { expiresAt: now - 1 });
      });
      const ready = await backfill(service);
      expect(ready.backfill).toMatchObject({ completedCollections: 3, scanned: 9, projected: 6, invalid: 3 });
      for (let i = 0; i < 3; i++) await service.advance();
      const cleaned = await service.getStatus();
      expect(cleaned.cleanup).toMatchObject({ deleted: 3, invalid: 0, lastCompletedAt: new Date(now).toISOString() });
      expect(cleaned.canAdvance).toBe(false);
      expect(cleaned.retryAt).toBe(new Date(now + 3600_000).toISOString());
      for (const collection of ['sessions', 'rates', 'idempotency']) {
        expect(await store.get(`${collection}/due`)).toBeNull();
        expect(await store.get(`${collection}/future`)).toEqual({ expiresAt: now + 60_000 });
        expect(await store.get(`${collection}/invalid`)).toEqual({ expiresAt: 'yesterday' });
      }
      for (const collection of ['auth_epochs', 'uploads', 'upload_requests', 'release_requests', 'comments', 'contacts', 'revisions', 'releases']) expect(await store.get(`${collection}/keep`)).not.toBeNull();
      expect(JSON.stringify(cleaned)).not.toContain('never-in-status');
      expect(await service.advance()).toEqual(cleaned);
      now += 3600_000;
      for (let i = 0; i < 3; i++) await service.advance();
      expect((await service.getStatus()).cleanup.deleted).toBe(6);
      expect((await service.getStatus()).backfill.invalid).toBe(3);
    } finally { if (store instanceof SqliteStore) await store.close(); }
  });
});

describe('expiry reconciliation races and budgets', () => {
  it('backfills exactly five legacy rows and rereads edits made after the paged scan', async () => {
    class EditedDuringScan extends MemoryStore {
      override async list<T>(collection: string, options?: { limit?: number; cursor?: string }) {
        const page = await super.list<T>(collection, options);
        if (collection === 'sessions') await this.transaction(async tx => { tx.put('sessions/a0', { expiresAt: start + 86400_000, renewed: true }); tx.delete('sessions/a1'); });
        return page;
      }
    }
    const store = new EditedDuringScan(Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`sessions/a${i}`, { expiresAt: start - 1 }])));
    expect((await store.queryExpired('sessions', { expiresBefore: start })).items).toEqual([]);
    const service = new ExpiryMaintenance(store, () => start);
    const first = await service.advance();
    expect(first.backfill).toMatchObject({ collection: 'sessions', scanned: 5, projected: 4 });
    expect((await store.queryExpired('sessions', { expiresBefore: start })).items.map(row => row.id)).toEqual(['a2', 'a3', 'a4']);
    expect(await store.get('sessions/a0')).toMatchObject({ renewed: true });
    expect(await store.get('sessions/a1')).toBeNull();
    await backfill(service);
    expect((await service.getStatus()).backfill.scanned).toBe(7);
  });

  it('rechecks actual expiry and current clock after a stale candidate query, retaining renewals and invalid values', async () => {
    let now = start;
    class ChangedDuringQuery extends MemoryStore {
      override async queryExpired(collection: ExpiryCollection, options: ExpiredQueryOptions): Promise<ExpiredQueryPage> {
        const page = await super.queryExpired(collection, options);
        if (collection === 'sessions') {
          await this.transaction(async tx => { tx.put('sessions/a', { expiresAt: start + 60_000 }); tx.put('sessions/b', { expiresAt: 'invalid' }); tx.delete('sessions/c'); });
          now = start - 1000;
        }
        return page;
      }
    }
    const store = new ChangedDuringQuery();
    await store.transaction(async tx => { for (const id of ['a', 'b', 'c', 'd']) tx.put(`sessions/${id}`, { expiresAt: start }); });
    const service = new ExpiryMaintenance(store, () => now);
    await backfill(service);
    const state = await service.advance();
    expect(state.cleanup).toMatchObject({ deleted: 0, renewed: 2, invalid: 1 });
    expect(await store.get('sessions/a')).toEqual({ expiresAt: start + 60_000 });
    expect(await store.get('sessions/b')).toEqual({ expiresAt: 'invalid' });
    expect(await store.get('sessions/d')).toEqual({ expiresAt: start });
    expect((await store.queryExpired('sessions', { expiresBefore: start - 1 })).items).toEqual([]);
  });

  it('blocks concurrent advances and fences an expired old lease after a replacement call finishes', async () => {
    let now = start, unblock!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    class SlowFirstScan extends MemoryStore {
      first = true;
      override async list<T>(collection: string, options?: { limit?: number; cursor?: string }) {
        const page = await super.list<T>(collection, options);
        if (this.first) { this.first = false; started(); await blocked; }
        return page;
      }
    }
    const store = new SlowFirstScan({ 'sessions/a': { expiresAt: start - 1 } }), service = new ExpiryMaintenance(store, () => now);
    const old = service.advance(); await entered;
    const busy = await service.advance(); expect(busy.busy).toBe(true); expect(busy.budget.stepsUsed).toBe(1);
    now += 120_001;
    const fresh = await service.advance(); expect(fresh.backfill.scanned).toBe(1); expect(fresh.budget.stepsUsed).toBe(2);
    unblock(); await old;
    expect((await service.getStatus()).backfill.scanned).toBe(1);
    expect((await service.getStatus()).budget.stepsUsed).toBe(2);
  });

  it('keeps failed page reservations, retries after lease expiry and counts committed cleanup once after lost acknowledgements', async () => {
    let now = start;
    class AmbiguousStore extends MemoryStore {
      failScan = true; loseCommit = false;
      override async list<T>(collection: string, options?: { limit?: number; cursor?: string }) {
        if (this.failScan) { this.failScan = false; throw new Error('scan unavailable'); }
        return super.list<T>(collection, options);
      }
      override async transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
        const result = await super.transaction(callback);
        if (this.loseCommit && result && typeof result === 'object' && 'phase' in result) { this.loseCommit = false; throw new Error('commit acknowledgement lost'); }
        return result;
      }
    }
    const store = new AmbiguousStore({ 'sessions/a': { expiresAt: start - 1 } }), service = new ExpiryMaintenance(store, () => now);
    await expect(service.advance()).rejects.toThrow('scan unavailable');
    expect((await service.getStatus()).budget.stepsUsed).toBe(1);
    expect((await service.advance()).busy).toBe(true);
    now += 120_001; await backfill(service);
    store.loseCommit = true;
    await expect(service.advance()).rejects.toThrow('commit acknowledgement lost');
    expect(await store.get('sessions/a')).toBeNull();
    expect((await service.getStatus()).cleanup.deleted).toBe(1);
    await service.advance(); expect((await service.getStatus()).cleanup.deleted).toBe(1);
  });

  it('enforces 192 daily pages before scanning, rolls forward at UTC midnight, and never resets on clock rollback', async () => {
    let now = start;
    const store = new MemoryStore(Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`rates/a${String(i).padStart(4, '0')}`, { expiresAt: start - 1 }]))), service = new ExpiryMaintenance(store, () => now);
    for (let i = 0; i < 192; i++) await service.advance();
    const stopped = await service.getStatus();
    expect(stopped).toMatchObject({ canAdvance: false, lastResult: 'budget_limited', budget: { day: '2026-09-29', stepsUsed: 192, readUnitsReserved: 8064, writeUnitsReserved: 1344, deleteUnitsReserved: 960 } });
    const checkpoint = await store.get(EXPIRY_MAINTENANCE_STATE);
    expect(await service.advance()).toEqual(stopped); expect(await store.get(EXPIRY_MAINTENANCE_STATE)).toEqual(checkpoint);
    now = Date.parse('2026-09-30T00:00:00.000Z');
    expect((await service.advance()).budget).toMatchObject({ day: '2026-09-30', stepsUsed: 1 });
    now = start;
    expect((await service.getStatus()).budget).toMatchObject({ day: '2026-09-30', stepsUsed: 1 });
    expect((await service.advance()).budget).toMatchObject({ day: '2026-09-30', stepsUsed: 2 });
  });

  it('leaves another bounded round available when a collection has more than five due records', async () => {
    const store = new MemoryStore(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`sessions/a${i}`, { expiresAt: start - 1 }]))), service = new ExpiryMaintenance(store, () => start);
    await backfill(service);
    for (let i = 0; i < 3; i++) await service.advance();
    expect(await service.getStatus()).toMatchObject({ canAdvance: true, cleanup: { deleted: 5 } });
    for (let i = 0; i < 3; i++) await service.advance();
    expect(await service.getStatus()).toMatchObject({ canAdvance: false, cleanup: { deleted: 6 } });
  });
});
