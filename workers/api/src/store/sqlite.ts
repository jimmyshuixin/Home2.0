// Node local server only. This module must never be imported by a Worker entry point.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BufferedTransaction, deserializeJson, listOptions, makeCursor, SerialQueue, StoreError, validateKey, validateKeys, type Store, type Transaction } from './types';
import { mediaCursor, mediaQueryOptions, mediaSortValue, type MediaQueryOptions, type MediaQueryPage } from './media-query';

const fileQueues = new Map<string, { queue: SerialQueue; references: number }>();
function isBusy(error: unknown): boolean {
  return error instanceof Error && /SQLITE_BUSY|database is locked|database table is locked/iu.test(error.message);
}
function storageError(error: unknown): Error { return error instanceof StoreError ? error : new StoreError('STORE_UNAVAILABLE'); }

export class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  readonly #queue: SerialQueue;
  readonly #fileKey: string | null;
  #closed = false;
  constructor(filename: string) {
    if (typeof filename !== 'string' || !filename || filename.includes('\u0000')) throw new StoreError('STORE_NOT_CONFIGURED');
    const path = filename === ':memory:' ? filename : resolve(filename);
    let opened: DatabaseSync | undefined;
    try {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
      this.#db = opened = new DatabaseSync(path);
      this.#db.exec('PRAGMA busy_timeout=1000');
      this.#db.exec('PRAGMA journal_mode=WAL');
      this.#db.exec('PRAGMA synchronous=FULL');
      this.#db.exec('CREATE TABLE IF NOT EXISTS documents (collection TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (collection, id)) WITHOUT ROWID');
      this.#db.function('media_sort', { deterministic: true }, (payload, sort) => mediaSortValue(JSON.parse(String(payload)), String(sort) as MediaQueryOptions['sort']));
      const canonical = path === ':memory:' ? null : realpathSync(path);
      this.#fileKey = canonical && process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      if (this.#fileKey) {
        const existing = fileQueues.get(this.#fileKey) ?? { queue: new SerialQueue(), references: 0 };
        existing.references++; fileQueues.set(this.#fileKey, existing); this.#queue = existing.queue;
      } else { this.#queue = new SerialQueue(); }
    } catch { try { opened?.close(); } catch { /* Keep the original initialization failure private. */ } throw new StoreError('STORE_UNAVAILABLE'); }
  }
  #assertOpen(): void { if (this.#closed) throw new StoreError('STORE_UNAVAILABLE'); }
  #read(key: string): string | null {
    const { collection, id } = validateKey(key);
    const row = this.#db.prepare('SELECT payload FROM documents WHERE collection=? AND id=?').get(collection, id);
    if (!row) return null;
    if (typeof row.payload !== 'string') throw new StoreError('STORE_UNAVAILABLE');
    return row.payload;
  }
  get<T>(key: string): Promise<T | null> {
    validateKey(key);
    return this.#queue.run(() => {
      this.#assertOpen();
      try { const payload = this.#read(key); return payload === null ? null : deserializeJson<T>(payload); }
      catch (error) { throw storageError(error); }
    });
  }
  async getMany<T>(keys: readonly string[]): Promise<Array<T | null>> {
    const checked = validateKeys(keys);
    return this.#queue.run(() => {
      this.#assertOpen();
      if (!checked.length) return [];
      try {
        const unique = [...new Set(checked)].map(validateKey);
        // One SQL statement also gives a consistent read when another process uses the same WAL file.
        const rows = this.#db.prepare(`SELECT collection,id,payload FROM documents WHERE ${unique.map(() => '(collection=? AND id=?)').join(' OR ')}`)
          .all(...unique.flatMap(key => [key.collection, key.id]));
        const payloads = new Map<string, string>();
        for (const row of rows) {
          if (typeof row.collection !== 'string' || typeof row.id !== 'string' || typeof row.payload !== 'string') throw new StoreError('STORE_UNAVAILABLE');
          payloads.set(`${row.collection}/${row.id}`, row.payload);
        }
        return checked.map(key => { const payload = payloads.get(key); return payload === undefined ? null : deserializeJson<T>(payload); });
      } catch (error) { throw storageError(error); }
    });
  }
  list<T>(collection: string, options?: { limit?: number; cursor?: string }): Promise<{ items: { id: string; data: T }[]; nextCursor: string | null }> {
    const { limit, after } = listOptions(collection, options);
    return this.#queue.run(() => {
      this.#assertOpen();
      try {
        const rows = this.#db.prepare('SELECT id,payload FROM documents WHERE collection=? AND id>? ORDER BY id COLLATE BINARY ASC LIMIT ?').all(collection, after, limit + 1);
        const items = rows.slice(0, limit).map(row => {
          if (typeof row.id !== 'string' || typeof row.payload !== 'string') throw new StoreError('STORE_UNAVAILABLE');
          return { id: row.id, data: deserializeJson<T>(row.payload) };
        });
        return { items, nextCursor: rows.length > limit ? makeCursor(collection, items[items.length - 1]!.id) : null };
      } catch (error) { throw storageError(error); }
    });
  }
  queryMedia<T>(options: MediaQueryOptions): Promise<MediaQueryPage<T>> {
    const { limit, after } = mediaQueryOptions(options), direction = options.direction === 'asc' ? 'ASC' : 'DESC', comparison = direction === 'ASC' ? '>' : '<';
    return this.#queue.run(() => {
      this.#assertOpen();
      try {
        const rows = this.#db.prepare(`SELECT id,payload,media_sort(payload,?) AS sort_value FROM documents WHERE collection='media_catalog' AND (?='' OR sort_value ${comparison} ?) ORDER BY sort_value COLLATE BINARY ${direction} LIMIT ?`).all(options.sort, after, after, limit + 1);
        const items = rows.slice(0, limit).map(row => ({ id: String(row.id), data: deserializeJson<T>(String(row.payload)), sortValue: String(row.sort_value) }));
        return { items, nextCursor: rows.length > limit ? mediaCursor(options, items.at(-1)!.sortValue) : null };
      } catch (error) { throw storageError(error); }
    });
  }
  transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.#queue.run(async () => {
      this.#assertOpen();
      for (let attempt = 0; attempt < 4; attempt++) {
        let begun = false;
        let inCallback = false;
        const tx = new BufferedTransaction(async key => { try { return this.#read(key); } catch (error) { throw storageError(error); } });
        try {
          this.#db.exec('BEGIN IMMEDIATE'); begun = true;
          inCallback = true;
          const result = await callback(tx);
          inCallback = false;
          const upsert = this.#db.prepare('INSERT INTO documents(collection,id,payload) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET payload=excluded.payload');
          const remove = this.#db.prepare('DELETE FROM documents WHERE collection=? AND id=?');
          for (const write of tx.finish()) {
            const { collection, id } = validateKey(write.key);
            if (write.payload === null) remove.run(collection, id); else upsert.run(collection, id, write.payload);
          }
          this.#db.exec('COMMIT');
          return result;
        } catch (error) {
          tx.discard();
          if (begun) { try { this.#db.exec('ROLLBACK'); } catch { throw new StoreError('STORE_UNAVAILABLE'); } }
          if (!inCallback && isBusy(error)) {
            if (attempt === 3) throw new StoreError('STORE_CONFLICT');
            await new Promise<void>(resolveWait => setTimeout(resolveWait, 25 * 2 ** attempt));
            continue;
          }
          // Business validation/optimistic-version errors are not infrastructure errors.
          if (inCallback) throw error;
          throw storageError(error);
        }
      }
      throw new StoreError('STORE_CONFLICT');
    });
  }
  close(): Promise<void> {
    return this.#queue.run(() => {
      if (this.#closed) return;
      this.#db.close(); this.#closed = true;
      if (this.#fileKey) {
        const entry = fileQueues.get(this.#fileKey);
        if (entry && --entry.references === 0) fileQueues.delete(this.#fileKey);
      }
    });
  }
}
