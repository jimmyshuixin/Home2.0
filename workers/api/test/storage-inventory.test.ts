import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { StorageInventory, STORAGE_INVENTORY_KEY, STORAGE_INVENTORY_BUDGET_KEY } from '../src/storage-inventory';
import type { StorageInventoryStatus } from '../src/storage-inventory-types';
import { SqliteStore } from '../src/store/sqlite';
import type { Store, Transaction } from '../src/store/types';

const started = Date.UTC(2026, 8, 29, 12);
let mf: Miniflare, bucket: R2Bucket, store: SqliteStore, clock: number;
let calls: { lists: number; gets: number };
beforeAll(async () => {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("test")}}', compatibilityDate: '2026-09-11', r2Buckets: ['INVENTORY'] }), telemetry: { enabled: false }, cf: false });
  bucket = await mf.getR2Bucket('INVENTORY') as unknown as R2Bucket;
});
beforeEach(async () => {
  for (;;) { const page = await bucket.list({ limit: 1000 }); if (page.objects.length) await bucket.delete(page.objects.map(row => row.key)); if (!page.truncated) break; }
  store = new SqliteStore(':memory:'); clock = started; calls = { lists: 0, gets: 0 };
});
afterEach(async () => { await store.close(); });
afterAll(async () => { await mf.dispose(); });
function reader(change: Partial<Pick<R2Bucket, 'list' | 'get'>> = {}): Pick<R2Bucket, 'list' | 'get'> {
  return {
    list: async options => { calls.lists++; expect(options?.limit).toBe(100); expect(options?.include).toEqual([]); return change.list ? change.list(options) : bucket.list(options); },
    get: (async (key: string) => { calls.gets++; expect(key).toBe('active-release.json'); return change.get ? change.get(key) : bucket.get(key); }) as R2Bucket['get'],
  };
}
const service = (custom = reader(), backing: Store = store) => new StorageInventory(backing, custom, () => clock);
const input = (state: StorageInventoryStatus) => ({ jobId: state.job!.id, expectedVersion: state.version });
async function finish(inventory: StorageInventory, state: StorageInventoryStatus, maximum = 250) {
  for (let i = 0; state.job?.canAdvance && state.job.status !== 'completed' && state.job.status !== 'limited' && i < maximum; i++) state = await inventory.advance(input(state));
  return state;
}
async function seedObjects(entries: Array<[string, string]>) { await Promise.all(entries.map(([key, data]) => bucket.put(key, data, { customMetadata: { privateMarker: 'DO_NOT_EXPOSE_METADATA' } }))); }
async function seedRecords(records: Array<{ id: string; status?: string; createdAt?: string; previousReleaseId?: string | null }>) {
  await store.transaction(async tx => { for (const row of records) tx.put(`releases/${row.id}`, { status: 'superseded', createdAt: new Date(started).toISOString(), selectedRevisionIds: { draft: 'PRIVATE_REVISION_ID' }, ...row, authorUid: 'PRIVATE_ADMIN', secret: 'DO_NOT_EXPOSE_RECORD' }); });
}
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

describe('read-only storage inventory on SQLite and real local workerd R2', () => {
  it('accounts real paginated objects by all source prefixes without HEAD/body/key disclosure or unfinished multipart', async () => {
    const entries: Array<[string, string]> = [
      ...Array.from({ length: 105 }, (_, i): [string, string] => [`originals/asset-${String(i).padStart(3, '0')}/source`, 'abc']),
      ...Array.from({ length: 7 }, (_, i): [string, string] => [`variants/asset-${i}/run/thumbnail`, 'ab']),
      ...Array.from({ length: 9 }, (_, i): [string, string] => [`releases/release-a/files/${i}.html`, 'abcd']),
      ['private-snapshots/release-a.json', '12345'], ['private-snapshot-sources/release-a.json', '12345'], ['private-snapshot-preparation/release-a.json', '12345'],
      ['misc/private-name.json', 'xy'], ['active-release.json', JSON.stringify({ schemaVersion: 1, releaseId: 'release-a' })],
    ];
    await seedObjects(entries); await seedRecords([{ id: 'release-a', status: 'live' }]);
    const upload = await bucket.createMultipartUpload('originals/not-completed/source'); await upload.uploadPart(1, 'unfinished');
    const inventory = service(); let state = await inventory.start({ expectedVersion: 0 });
    expect(calls).toEqual({ lists: 0, gets: 0 });
    state = await inventory.advance(input(state)); expect(state.job?.total.count).toBe(100); expect(state.job?.phase).toBe('objects');
    state = await finish(inventory, state);
    expect(state.job).toMatchObject({ status: 'completed', r2Pages: 2, releaseRecords: 1, total: { count: entries.length, bytes: entries.reduce((n, [, value]) => n + new TextEncoder().encode(value).length, 0) }, totals: { originals: { bytes: 315, count: 105 }, variants: { bytes: 14, count: 7 }, releases: { bytes: 36, count: 9 }, snapshots: { bytes: 15, count: 3 } } });
    expect(calls).toEqual({ lists: 2, gets: 2 }); expect(state.retention?.entries[0]).toMatchObject({ releaseId: 'release-a', disposition: 'protect', deleteAllowed: false });
    const rendered = JSON.stringify(state);
    for (const privateValue of ['"cursor"', 'originals/asset', 'misc/private-name', 'DO_NOT_EXPOSE', 'PRIVATE_REVISION_ID', 'PRIVATE_ADMIN', '"lease"', '"token"']) expect(rendered).not.toContain(privateValue);
    expect((await bucket.list({ limit: 1000 })).objects).toHaveLength(entries.length);
    await upload.abort();
  });
  it('completes an empty real bucket without treating absence of active release as an error', async () => {
    const inventory = service(); const state = await finish(inventory, await inventory.start({ expectedVersion: 0 }));
    expect(state.job).toMatchObject({ status: 'completed', phase: 'done', total: { bytes: 0, count: 0 }, r2Pages: 1, releaseRecords: 0, finishedAt: new Date(clock).toISOString() });
    expect(state.retention).toMatchObject({ activeObservation: 'absent', objectScanComplete: true, metadataComplete: true, entries: [], deleteAllowed: false });
  });
  it('protects observed active pointers, in-flight states and recent history but labels old live and unknown references honestly', async () => {
    const records = [
      { id: 'old-live', status: 'live', createdAt: '2020-01-01T00:00:00.000Z' },
      { id: 'first-active', status: 'superseded', createdAt: '2020-02-01T00:00:00.000Z' },
      { id: 'last-active', status: 'superseded', createdAt: '2020-03-01T00:00:00.000Z' },
      ...['queued', 'building', 'ready', 'activating', 'reconciling'].map(status => ({ id: `protected-${status}`, status, createdAt: '2020-04-01T00:00:00.000Z' })),
      ...[1, 2, 3].map(n => ({ id: `recent-${n}`, status: 'superseded', createdAt: `2026-09-${20 + n}T00:00:00.000Z` })),
      { id: 'history', status: 'failed', createdAt: '2020-01-01T00:00:00.000Z', previousReleaseId: 'old-live' },
    ];
    await seedRecords(records); await seedObjects([['releases/missing-record/manifest.json', '{}'], ['active-release.json', JSON.stringify({ schemaVersion: 1, releaseId: 'first-active' })]]);
    const inventory = service(); let state = await inventory.advance(input(await inventory.start({ expectedVersion: 0, keepRecent: 3 })));
    await bucket.put('active-release.json', JSON.stringify({ schemaVersion: 1, releaseId: 'last-active' })); clock += 1000;
    state = await finish(inventory, state);
    expect(state.retention?.activeReleaseIds).toEqual(['first-active', 'last-active']);
    const entry = (id: string) => state.retention!.entries.find(row => row.releaseId === id)!;
    for (const id of ['first-active', 'last-active', 'protected-queued', 'protected-building', 'protected-ready', 'protected-activating', 'protected-reconciling', 'recent-1', 'recent-2', 'recent-3']) expect(entry(id).disposition).toBe('protect');
    expect(entry('old-live')).toMatchObject({ disposition: 'review_only', referencedByReleaseIds: ['history'], referenceCoverage: 'unknown', deleteAllowed: false });
    expect(entry('old-live').reasons.join(' ')).toContain('历史 live'); expect(entry('missing-record').disposition).toBe('unknown');
    expect(state.retention!.entries.every(row => row.deleteAllowed === false)).toBe(true); expect(state.retention?.recentPolicyComplete).toBe(true);
  });
  it('resumes persisted checkpoints after pause/reload, and stale repeated requests cannot double-count', async () => {
    await seedObjects(Array.from({ length: 101 }, (_, i) => [`originals/a${i}/source`, 'x']));
    const inventory = service(); const start = await inventory.start({ expectedVersion: 0 }); const first = await inventory.advance(input(start));
    const replay = await inventory.advance(input(start)); expect(replay.version).toBe(first.version); expect(calls.lists).toBe(1);
    const paused = await inventory.pause(input(first)); expect(paused.job?.status).toBe('paused');
    expect((await inventory.pause(input(first))).version).toBe(paused.version);
    const reloaded = service(); const finished = await finish(reloaded, await reloaded.getStatus());
    expect(finished.job).toMatchObject({ status: 'completed', total: { count: 101, bytes: 101 } }); expect(calls.lists).toBe(2);
  });
  it('leases a page once under concurrent advance and fences in-flight work when paused', async () => {
    await seedObjects([['originals/a/source', 'data']]); const entered = barrier(), unblock = barrier();
    const inventory = service(reader({ list: async options => { entered.release(); await unblock.promise; return bucket.list(options); } }));
    const start = await inventory.start({ expectedVersion: 0 }), inFlight = inventory.advance(input(start)); await entered.promise;
    const concurrent = await inventory.advance(input(start)); expect(concurrent.job).toMatchObject({ busy: true, total: { count: 0 } }); expect(calls.lists).toBe(1);
    const paused = await inventory.pause(input(start)); unblock.release(); await inFlight;
    expect((await inventory.getStatus()).job).toMatchObject({ status: 'paused', total: { count: 0 } });
    const finished = await finish(service(), paused); expect(finished.job?.total).toEqual({ bytes: 4, count: 1 }); expect(finished.budget.attemptsUsed).toBe(3);
  });
  it('recovers an expired lease and rejects its late result without double counting', async () => {
    await seedObjects([['originals/a/source', 'data']]); const entered = barrier(), unblock = barrier(); let first = true;
    const inventory = service(reader({ list: async options => { if (first) { first = false; entered.release(); await unblock.promise; } return bucket.list(options); } }));
    const start = await inventory.start({ expectedVersion: 0 }), abandoned = inventory.advance(input(start)); await entered.promise; clock += 60_001;
    const recovered = await inventory.advance(input(start)); expect(recovered.job?.total.count).toBe(1);
    unblock.release(); await abandoned;
    expect((await inventory.getStatus()).job).toMatchObject({ total: { count: 1, bytes: 4 }, attempts: 2 });
  });
  it('retains checkpoint after R2 failure, sanitizes diagnostics, and retries exactly that page', async () => {
    await seedObjects([['originals/a/source', 'data']]); let failing = true;
    const inventory = service(reader({ list: async options => { if (failing) throw new Error('SECRET_KEY original/private-file upstream token'); return bucket.list(options); } }));
    const failed = await inventory.advance(input(await inventory.start({ expectedVersion: 0 })));
    expect(failed.job).toMatchObject({ status: 'failed', total: { count: 0 }, lastError: { code: 'INVENTORY_READ_FAILED', retryable: true } }); expect(JSON.stringify(failed)).not.toContain('SECRET_KEY');
    failing = false; const completed = await finish(inventory, failed);
    expect(completed.job).toMatchObject({ status: 'completed', total: { count: 1, bytes: 4 }, attempts: 3, lastError: null });
  });
  it('uses truncated, not length, to continue provider-short pages', async () => {
    await seedObjects([['originals/a/source', 'a'], ['originals/b/source', 'bb']]);
    const inventory = service(reader({ list: options => bucket.list({ ...options, limit: 1 }) }));
    const state = await finish(inventory, await inventory.start({ expectedVersion: 0 }));
    expect(state.job).toMatchObject({ status: 'completed', r2Pages: 2, total: { bytes: 3, count: 2 } });
  });
  it('enforces global UTC-day attempts and start quotas across service instances', async () => {
    await store.transaction(async tx => { tx.put(STORAGE_INVENTORY_BUDGET_KEY, { day: '2026-09-29', attempts: 199, starts: 0 }); });
    const inventory = service(); let state = await inventory.advance(input(await inventory.start({ expectedVersion: 0 })));
    expect(state.budget.attemptsUsed).toBe(200); state = await service().advance(input(state)); expect(state.job?.status).toBe('paused'); expect(calls.lists).toBe(1);
    clock += 86_400_000; state = await finish(service(), await service().getStatus()); expect(state.job?.status).toBe('completed'); expect(state.budget.attemptsUsed).toBe(1);
    for (let i = 0; i < 3; i++) state = await finish(inventory, await inventory.start({ expectedVersion: state.version }));
    await expect(inventory.start({ expectedVersion: state.version })).rejects.toMatchObject({ code: 'INVENTORY_DAILY_BUDGET', status: 429 });
  });
  it('reports partial metadata at the record cap and bounds object release-group retention', async () => {
    await seedObjects(Array.from({ length: 201 }, (_, i) => [`releases/release-${String(i).padStart(3, '0')}/files/index.html`, 'x']));
    await seedRecords(Array.from({ length: 201 }, (_, i) => ({ id: `release-${String(i).padStart(3, '0')}` })));
    const state = await finish(service(), await service().start({ expectedVersion: 0 }));
    expect(state.job).toMatchObject({ status: 'limited', releaseRecords: 200, total: { count: 201 } });
    expect(state.retention).toMatchObject({ objectScanComplete: true, metadataComplete: false, recentPolicyComplete: false, releaseGroupsTruncated: true, unknownReleaseObjects: { bytes: 1, count: 1 } });
    expect(state.retention!.entries.filter(row => row.disposition === 'review_only')).toHaveLength(0);
  });
  it('marks the R2 page cap partial and does not invoke one extra list', async () => {
    await seedObjects(Array.from({ length: 201 }, (_, i) => [`originals/a${String(i).padStart(3, '0')}/source`, 'x']));
    const inventory = service(reader({ list: options => bucket.list({ ...options, limit: 1 }) }));
    const state = await finish(inventory, await inventory.start({ expectedVersion: 0 }));
    expect(state.job).toMatchObject({ status: 'limited', r2Pages: 200, total: { count: 200 } }); expect(state.retention?.objectScanComplete).toBe(false); expect(calls.lists).toBe(200);
  }, 30000);
  it('keeps external R2 I/O outside replayed Store transaction callbacks', async () => {
    let inCallback = false, rolledForward = false;
    class ReplayingStore implements Store {
      get<T>(key: string) { return store.get<T>(key); }
      getMany<T>(keys: readonly string[]) { return store.getMany<T>(keys); }
      list<T>(collection: string, options?: { limit?: number; cursor?: string }) { return store.list<T>(collection, options); }
      async transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
        const retry = new Error('test-only-rollback');
        try { await store.transaction(async tx => { inCallback = true; try { await callback(tx); throw retry; } finally { inCallback = false; } }); } catch (error) { if (error !== retry) throw error; }
        if (!rolledForward) { clock += 86_400_000; rolledForward = true; }
        return store.transaction(async tx => { inCallback = true; try { return await callback(tx); } finally { inCallback = false; } });
      }
    }
    const inventory = service(reader({ list: options => { expect(inCallback).toBe(false); return bucket.list(options); }, get: ((key: string) => { expect(inCallback).toBe(false); return bucket.get(key); }) as R2Bucket['get'] }), new ReplayingStore());
    const state = await finish(inventory, await inventory.start({ expectedVersion: 0 }));
    expect(state.job).toMatchObject({ status: 'completed', attempts: 2 }); expect(calls).toEqual({ lists: 1, gets: 2 }); expect(state.budget).toMatchObject({ attemptsUsed: 2, startsUsed: 1 });
    expect(state.job?.startedAt).toBe(new Date(started + 86_400_000).toISOString()); expect(state.budget.day).toBe('2026-09-30');
  });
  it('reads time after queued transactions acquire state, including midnight advance and pause', async () => {
    const inventory = service(); const entered = barrier(), release = barrier();
    const lock = store.transaction(async () => { entered.release(); await release.promise; }); await entered.promise;
    const starting = inventory.start({ expectedVersion: 0 }); clock = Date.UTC(2026, 8, 30, 0, 0, 1); release.release(); await lock;
    const start = await starting; expect(start.job?.startedAt).toBe(new Date(clock).toISOString()); expect(start.budget.day).toBe('2026-09-30');
    const entered2 = barrier(), release2 = barrier(); const lock2 = store.transaction(async () => { entered2.release(); await release2.promise; }); await entered2.promise;
    const advancing = inventory.advance(input(start)); clock = Date.UTC(2026, 9, 1, 0, 0, 1); release2.release(); await lock2;
    const advanced = await advancing; expect(advanced.budget).toMatchObject({ day: '2026-10-01', attemptsUsed: 1, startsUsed: 0 }); expect(advanced.job?.total.count).toBe(0);
    const entered3 = barrier(), release3 = barrier(); const lock3 = store.transaction(async () => { entered3.release(); await release3.promise; }); await entered3.promise;
    const pausing = inventory.pause(input(advanced)); clock += 1000; release3.release(); await lock3;
    expect((await pausing).job).toMatchObject({ status: 'paused', updatedAt: new Date(clock).toISOString() });
  });
  it('keeps one monotonic UTC-day budget record and grants no quota after clock rollback', async () => {
    const inventory = service(); const start = await inventory.start({ expectedVersion: 0 });
    await store.transaction(async tx => { tx.put(STORAGE_INVENTORY_BUDGET_KEY, { day: '2026-09-30', attempts: 200, starts: 3 }); });
    clock = Date.UTC(2026, 8, 29, 13);
    const earlier = await inventory.getStatus(); expect(earlier.budget).toMatchObject({ day: '2026-09-30', attemptsUsed: 200, startsUsed: 3, resetsAt: '2026-10-01T00:00:00.000Z' });
    const denied = await inventory.advance(input(start)); expect(denied.job?.status).toBe('paused'); expect(calls.lists).toBe(0);
    clock = Date.UTC(2026, 9, 1); const restored = await inventory.advance(input(denied)); expect(restored.budget).toMatchObject({ day: '2026-10-01', attemptsUsed: 1, startsUsed: 0 });
    clock = Date.UTC(2026, 8, 30); expect((await inventory.getStatus()).budget).toMatchObject({ day: '2026-10-01', attemptsUsed: 1, startsUsed: 0 });
    expect((await store.list('maintenance', { limit: 50 })).items.map(row => row.id).sort()).toEqual(['storage_inventory', 'storage_inventory_budget']);
  });
  it('discards a result that outlives its lease even when nobody reclaimed it', async () => {
    await seedObjects([['originals/a/source', 'x']]); const entered = barrier(), unblock = barrier(); let slow = true;
    const inventory = service(reader({ list: async options => { if (slow) { entered.release(); await unblock.promise; } return bucket.list(options); } }));
    const start = await inventory.start({ expectedVersion: 0 }), pending = inventory.advance(input(start)); await entered.promise; clock += 60_001; unblock.release();
    const expired = await pending; expect(expired.version).toBe(start.version); expect(expired.job).toMatchObject({ total: { count: 0 }, busy: false, canAdvance: true });
    slow = false; const completed = await finish(inventory, expired); expect(completed.job).toMatchObject({ status: 'completed', total: { count: 1 }, attempts: 3 });
  });
  it('does not allow new failed builds to displace recent rollback versions', async () => {
    await seedRecords([
      ...[1, 2, 3].map(i => ({ id: `success-${i}`, status: 'live', createdAt: `2026-08-0${i}T00:00:00.000Z` })),
      ...[1, 2, 3, 4, 5, 6].map(i => ({ id: `failed-${i}`, status: 'failed', createdAt: `2026-09-0${i}T00:00:00.000Z` })),
    ]);
    const state = await finish(service(), await service().start({ expectedVersion: 0, keepRecent: 3 }));
    expect(state.retention?.entries.filter(row => row.disposition === 'protect').map(row => row.releaseId)).toEqual(['success-1', 'success-2', 'success-3']);
    expect(state.retention?.entries.filter(row => row.releaseStatus === 'failed').every(row => row.disposition === 'review_only')).toBe(true);
  });
  it('does not count a page twice after its final commit succeeded but the acknowledgement was lost', async () => {
    await seedObjects([['originals/a/source', 'x']]); let lost = false;
    const flaky: Store = {
      get: <T>(key: string) => store.get<T>(key), getMany: <T>(keys: readonly string[]) => store.getMany<T>(keys), list: <T>(collection: string, options?: { limit?: number; cursor?: string }) => store.list<T>(collection, options),
      transaction: async <T>(callback: (tx: Transaction) => Promise<T>) => {
        const result = await store.transaction(callback), current = await store.get<{ version: number; job: { total: { count: number } } }>(STORAGE_INVENTORY_KEY);
        if (!lost && current?.job.total.count === 1) { lost = true; throw new Error('commit acknowledgement lost'); }
        return result;
      },
    };
    const inventory = service(reader(), flaky), start = await inventory.start({ expectedVersion: 0 }), result = await inventory.advance(input(start));
    expect(result.job).toMatchObject({ total: { count: 1, bytes: 1 }, lastError: null });
    const replay = await inventory.advance(input(start)); expect(replay.job?.total.count).toBe(1); expect(calls.lists).toBe(1);
    expect((await finish(inventory, replay)).job?.status).toBe('completed');
  });
  it('limits exhausted retry attempts without trapping a permanently unresumable failed job', async () => {
    const inventory = service(reader({ list: async () => { throw new Error('unavailable'); } })); const start = await inventory.start({ expectedVersion: 0 });
    await store.transaction(async tx => { const current = await tx.get<Record<string, unknown> & { job: Record<string, unknown> }>(STORAGE_INVENTORY_KEY); tx.put(STORAGE_INVENTORY_KEY, { ...current, job: { ...current!.job, attempts: 399 } }); });
    const limited = await inventory.advance(input(start)); expect(limited.job).toMatchObject({ status: 'limited', attempts: 400, canAdvance: false, lastError: { retryable: false, code: 'INVENTORY_RUN_LIMIT' } });
    const replacement = await inventory.start({ expectedVersion: limited.version }); expect(replacement.job?.id).not.toBe(limited.job?.id); expect(replacement.job?.status).toBe('running');
  });
  it('deduplicates concurrent start requests without spending extra daily starts', async () => {
    const inventory = service(); const [a, b] = await Promise.all([inventory.start({ expectedVersion: 0 }), inventory.start({ expectedVersion: 0 })]);
    expect(a.job?.id).toBe(b.job?.id); expect(a.budget.startsUsed).toBe(1); expect((await inventory.getStatus()).version).toBe(1);
  });
  it('makes the final successful attempt terminal when more work remains', async () => {
    const inventory = service(); const start = await inventory.start({ expectedVersion: 0 });
    await store.transaction(async tx => { const current = await tx.get<Record<string, unknown> & { job: Record<string, unknown> }>(STORAGE_INVENTORY_KEY); tx.put(STORAGE_INVENTORY_KEY, { ...current, job: { ...current!.job, attempts: 399 } }); });
    const result = await inventory.advance(input(start)); expect(result.job).toMatchObject({ status: 'limited', phase: 'release_records', attempts: 400, canAdvance: false });
    expect((await inventory.start({ expectedVersion: result.version })).job?.id).not.toBe(start.job?.id);
  });
  it('allows a zero-I/O limit checkpoint after the final attempt expires, even with daily budget exhausted', async () => {
    const entered = barrier(), release = barrier();
    const inventory = service(reader({ list: async options => { entered.release(); await release.promise; return bucket.list(options); } })); const start = await inventory.start({ expectedVersion: 0 });
    await store.transaction(async tx => { const current = await tx.get<Record<string, unknown> & { job: Record<string, unknown> }>(STORAGE_INVENTORY_KEY); tx.put(STORAGE_INVENTORY_KEY, { ...current, job: { ...current!.job, attempts: 399 } }); tx.put(STORAGE_INVENTORY_BUDGET_KEY, { day: '2026-09-29', attempts: 199, starts: 1 }); });
    const pending = inventory.advance(input(start)); await entered.promise; clock += 60_001; release.release(); const expired = await pending;
    expect(expired.job).toMatchObject({ status: 'running', attempts: 400, busy: false, canAdvance: true }); expect(expired.budget.attemptsUsed).toBe(200);
    const readsBefore = { ...calls }, limited = await inventory.advance(input(expired));
    expect(limited.job).toMatchObject({ status: 'limited', canAdvance: false }); expect(calls).toEqual(readsBefore); expect(limited.budget.attemptsUsed).toBe(200);
    clock += 86_400_000; expect((await inventory.start({ expectedVersion: limited.version })).job?.id).not.toBe(start.job?.id);
  });
  it('rejects invalid inputs and never emits malformed active-pointer content', async () => {
    const inventory = service();
    await expect(inventory.start({ expectedVersion: -1 })).rejects.toMatchObject({ status: 422 });
    await expect(inventory.start({ expectedVersion: 0, keepRecent: 1 })).rejects.toMatchObject({ status: 422 });
    await seedObjects([['active-release.json', JSON.stringify({ schemaVersion: 1, releaseId: '../SECRET_PRIVATE_KEY' })]]);
    const failed = await inventory.advance(input(await inventory.start({ expectedVersion: 0 })));
    expect(failed.job?.lastError?.code).toBe('INVENTORY_ACTIVE_INVALID'); expect(JSON.stringify(failed)).not.toContain('SECRET_PRIVATE_KEY'); expect(calls.lists).toBe(0);
    await expect(inventory.advance({ jobId: 'another-job', expectedVersion: failed.version })).rejects.toMatchObject({ status: 409 });
    expect((await store.get<{ job: { lease: unknown } }>(STORAGE_INVENTORY_KEY))?.job.lease).toBe(null);
  });
});
