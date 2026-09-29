import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MemoryStore } from '../src/store/memory';
import { SqliteStore } from '../src/store/sqlite';
import { PublicComments, PUBLIC_COMMENT_CATALOG_STATE } from '../src/store/public-comments';
import { commentTargetPrefix, publicCommentQueryOptions, type PublicComment } from '../src/store/public-comment-query';
import { type Store } from '../src/store/types';

const guestbook = { targetType: 'guestbook', targetId: null } as const;
function comment(id: string, target = guestbook as { targetType: 'guestbook' | 'creation' | 'album'; targetId: string | null }, time = '2026-09-29T00:00:00.000Z') {
  return { ...target, id, nickname: `访客${id}`, body: `真实格式测试 ${id}`, createdAt: time, updatedAt: time, version: 1, status: 'approved', email: 'private@example.invalid', moderationNote: 'private note' };
}
const legacy = Object.fromEntries([
  ...Array.from({ length: 55 }, (_, i) => { const id = `a${String(i).padStart(3, '0')}`; return [`public_comments/${id}`, comment(id, { targetType: 'album', targetId: 'album-one' })]; }),
  ...Array.from({ length: 30 }, (_, i) => { const id = `z${String(i).padStart(3, '0')}`; return [`public_comments/${id}`, comment(id, guestbook, new Date(Date.UTC(2026, 8, 29, 0, Math.floor(i / 2))).toISOString())]; }),
]);

describe.each(['memory', 'sqlite'] as const)('%s public comment catalog, migration and pagination', kind => {
  let store: Store, repository: PublicComments, close: () => Promise<void>;
  beforeEach(() => {
    if (kind === 'memory') { store = new MemoryStore(legacy); close = async () => {}; }
    else {
      const directory = mkdtempSync(join(tmpdir(), 'xvyin-comments-test-')), path = join(directory, 'records.sqlite');
      // Seed the actual old JSON-only format, bypassing the new transaction projection deliberately.
      const db = new DatabaseSync(path);
      db.exec('CREATE TABLE documents (collection TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(collection,id)) WITHOUT ROWID');
      const put = db.prepare('INSERT INTO documents(collection,id,payload) VALUES(?,?,?)');
      for (const [key, value] of Object.entries(legacy)) { const [collection, id] = key.split('/'); put.run(collection!, id!, JSON.stringify(value)); }
      db.close();
      const sqlite = new SqliteStore(path); store = sqlite;
      close = async () => { await sqlite.close(); const target = resolve(directory); if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('xvyin-comments-test-')) throw new Error('Unexpected test path'); rmSync(target, { recursive: true, force: true }); };
    }
    repository = new PublicComments(store);
  });
  afterEach(async () => { await close(); });
  async function finish() {
    let state = await repository.catalogStatus();
    for (let i = 0; !state.ready && i < 50; i++) { const previous = state.processed; state = await repository.advanceCatalog(); expect(state.processed - previous).toBeLessThanOrEqual(5); }
    expect(state.ready).toBe(true); return state;
  }

  it('keeps legacy rows visible during bounded backfill, then returns newest matching targets before applying limit', async () => {
    const first = await repository.list({ ...guestbook, limit: 12 });
    expect(first.catalogReady).toBe(false); expect(first.items).toEqual([]); expect(first.nextCursor).toBeTruthy();
    const oldPage = await repository.list({ ...guestbook, limit: 12, cursor: first.nextCursor! });
    expect(oldPage.items).toHaveLength(12); expect(oldPage.items[0]!.id).toBe('z000'); expect(oldPage.nextCursor).toBeTruthy();
    const oldNext = await repository.list({ ...guestbook, limit: 12, cursor: oldPage.nextCursor! });
    expect(oldNext.items.map(row => row.id)).toEqual(Array.from({ length: 12 }, (_, i) => `z${String(i + 12).padStart(3, '0')}`));
    const state = await finish(); expect(state.processed).toBe(85);
    const indexed = await repository.list({ ...guestbook, limit: 12 });
    expect(indexed.catalogReady).toBe(true); expect(indexed.items.map(row => row.id)).toEqual(Array.from({ length: 12 }, (_, i) => `z${String(29 - i).padStart(3, '0')}`));
    expect(Object.keys(indexed.items[0]!)).toEqual(['id', 'nickname', 'body', 'createdAt']);
    await expect(repository.list({ ...guestbook, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_CURSOR', status: 422 });
  });

  it('paginates identical timestamps without duplicates and rejects cross-target cursors and invalid limits', async () => {
    await finish();
    const ids: string[] = []; let cursor: string | undefined;
    do { const page = await repository.list({ ...guestbook, limit: 7, ...(cursor ? { cursor } : {}) }); ids.push(...page.items.map(row => row.id)); cursor = page.nextCursor ?? undefined; } while (cursor);
    expect(ids).toHaveLength(30); expect(new Set(ids).size).toBe(30); expect(ids.at(-1)).toBe('z000');
    const page = await repository.list({ ...guestbook, limit: 12 });
    await expect(repository.list({ targetType: 'album', targetId: 'album-one', cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_CURSOR', status: 422 });
    for (const limit of [0, -1, 51, 1.5, Number.NaN]) await expect(repository.list({ ...guestbook, limit })).rejects.toMatchObject({ code: 'INVALID_COMMENT_QUERY', status: 422 });
    await expect(repository.list({ targetType: 'guestbook', targetId: 'ignored' })).rejects.toMatchObject({ code: 'INVALID_COMMENT_QUERY' });
    expect(() => publicCommentQueryOptions({ ...guestbook, cursor: '' })).toThrow();
  });

  it('maintains approval and hiding atomically, including a deleted page-boundary row and new newest comment', async () => {
    await finish();
    const first = await repository.list({ ...guestbook, limit: 2 });
    await store.transaction(async tx => { tx.delete('public_comments/z028'); tx.put('public_comments/newest', comment('newest', guestbook, '2026-09-30T00:00:00.000Z')); });
    expect(await store.get('public_comment_catalog/z028')).toBeNull();
    const next = await repository.list({ ...guestbook, limit: 2, cursor: first.nextCursor! }); expect(next.items.map(row => row.id)).toEqual(['z027', 'z026']);
    expect((await repository.list({ ...guestbook, limit: 2 })).items.map(row => row.id)).toEqual(['newest', 'z029']);
    const projected = await store.get<Record<string, unknown>>('public_comment_catalog/newest'); expect(projected).not.toHaveProperty('email'); expect(projected).not.toHaveProperty('moderationNote');
    await expect(store.transaction(async tx => { tx.delete('public_comments/newest'); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect((await repository.list({ ...guestbook, limit: 1 })).items[0]!.id).toBe('newest');
    await store.transaction(async tx => { tx.put('public_comments/newest', { ...comment('newest'), status: 'hidden' }); });
    expect(await store.get('public_comment_catalog/newest')).toBeNull();
  });

  it('re-reads backfill sources after concurrent moderation and handles approvals behind its cursor', async () => {
    let scanned!: () => void, resume!: () => void;
    const started = new Promise<void>(resolve => { scanned = resolve; }), allowed = new Promise<void>(resolve => { resume = resolve; });
    const wrapped = new Proxy(store, { get(target, key) { if (key === 'list') return async (...args: Parameters<Store['list']>) => { const page = await target.list(...args); scanned(); await allowed; return page; }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
    const advancing = new PublicComments(wrapped).advanceCatalog(); await started;
    await store.transaction(async tx => { tx.delete('public_comments/a000'); tx.put('public_comments/A-before-cursor', comment('A-before-cursor', guestbook, '2026-10-01T00:00:00.000Z')); });
    resume(); await advancing;
    expect(await store.get('public_comment_catalog/a000')).toBeNull();
    await finish();
    expect((await repository.list({ ...guestbook, limit: 1 })).items[0]!.id).toBe('A-before-cursor');
  });

  it('serializes concurrent migration steps and projects approvals arriving at EOF and after ready', async () => {
    const steps = await Promise.all([repository.advanceCatalog(), repository.advanceCatalog()]);
    expect(steps.map(state => state.processed)).toEqual([5, 5]);
    let state = await repository.catalogStatus();
    while (state.cursor && state.processed < 80) state = await repository.advanceCatalog();
    let scanned!: () => void, resume!: () => void;
    const started = new Promise<void>(resolve => { scanned = resolve; }), allowed = new Promise<void>(resolve => { resume = resolve; });
    const wrapped = new Proxy(store, { get(target, key) { if (key === 'list') return async (...args: Parameters<Store['list']>) => { const page = await target.list(...args); expect(page.nextCursor).toBeNull(); scanned(); await allowed; return page; }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
    const finishing = new PublicComments(wrapped).advanceCatalog(); await started;
    await store.transaction(async tx => { tx.put('public_comments/zz-after-scan', comment('zz-after-scan', guestbook, '2026-10-02T00:00:00.000Z')); tx.delete('public_comments/z029'); });
    resume(); expect((await finishing).ready).toBe(true);
    expect((await repository.list({ ...guestbook, limit: 1 })).items[0]!.id).toBe('zz-after-scan');
    expect(await store.get('public_comment_catalog/z029')).toBeNull();
    await store.transaction(async tx => { tx.put('public_comments/new-after-ready', comment('new-after-ready', guestbook, '2026-10-03T00:00:00.000Z')); });
    expect((await repository.list({ ...guestbook, limit: 1 })).items[0]!.id).toBe('new-after-ready');
    expect(await repository.advanceCatalog()).toEqual(await store.get(PUBLIC_COMMENT_CATALOG_STATE));
  });
});

it('keeps target prefixes disjoint for similar IDs', () => {
  expect(commentTargetPrefix({ targetType: 'album', targetId: 'a' })).not.toBe(commentTargetPrefix({ targetType: 'album', targetId: 'a-b' }));
  expect(() => commentTargetPrefix({ targetType: 'creation', targetId: '../private' })).toThrow();
});
