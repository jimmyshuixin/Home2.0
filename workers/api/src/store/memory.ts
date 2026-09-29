import { BufferedTransaction, deserializeJson, listOptions, makeCursor, SerialQueue, serializeJson, validateKey, validateKeys, type Store, type Transaction } from './types';
import { mediaCursor, mediaQueryOptions, mediaSortValue, type MediaQueryOptions, type MediaQueryPage } from './media-query';
import { PUBLIC_COMMENT_CATALOG, publicCommentCursor, publicCommentQueryOptions, publicCommentSortValue, type PublicComment, type PublicCommentQueryOptions, type PublicCommentQueryPage } from './public-comment-query';
import { expiredQueryOptions, type ExpiryCollection, type ExpiredQueryOptions, type ExpiredQueryPage } from './expiry-query';

/** Unit-test adapter only. Production and local development must select persistent storage. */
export class MemoryStore implements Store {
  readonly #records = new Map<string, string>();
  readonly #expiries = new Map<string, number>();
  readonly #queue = new SerialQueue();
  constructor(seed: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(seed)) { validateKey(key); this.#records.set(key, serializeJson(value)); }
  }
  get<T>(key: string): Promise<T | null> {
    validateKey(key);
    return this.#queue.run(() => { const value = this.#records.get(key); return value === undefined ? null : deserializeJson<T>(value); });
  }
  async getMany<T>(keys: readonly string[]): Promise<Array<T | null>> {
    const checked = validateKeys(keys);
    return this.#queue.run(() => checked.map(key => {
      const value = this.#records.get(key); return value === undefined ? null : deserializeJson<T>(value);
    }));
  }
  queryMedia<T>(options: MediaQueryOptions): Promise<MediaQueryPage<T>> {
    const { limit, after } = mediaQueryOptions(options), direction = options.direction === 'asc' ? 1 : -1;
    return this.#queue.run(() => {
      const rows = [...this.#records.entries()].filter(([key]) => key.startsWith('media_catalog/')).map(([key, payload]) => {
        const data = deserializeJson<Record<string, unknown>>(payload); return { id: key.slice(14), data: data as T, sortValue: mediaSortValue(data, options.sort) };
      }).filter(row => !after || (row.sortValue > after ? 1 : row.sortValue < after ? -1 : 0) * direction > 0)
        .sort((a, b) => (a.sortValue < b.sortValue ? -1 : a.sortValue > b.sortValue ? 1 : 0) * direction).slice(0, limit + 1);
      const items = rows.slice(0, limit); return { items, nextCursor: rows.length > limit ? mediaCursor(options, items.at(-1)!.sortValue) : null };
    });
  }
  queryExpired(collection: ExpiryCollection, options: ExpiredQueryOptions): Promise<ExpiredQueryPage> {
    const { limit, expiresBefore } = expiredQueryOptions(collection, options);
    return this.#queue.run(() => {
      const prefix = `${collection}/`;
      const rows = [...this.#expiries.entries()].filter(([key, expiry]) => key.startsWith(prefix) && expiry <= expiresBefore)
        .map(([key, expiresAt]) => ({ id: key.slice(prefix.length), expiresAt }))
        .sort((a, b) => a.expiresAt - b.expiresAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit + 1);
      return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }
  queryPublicComments(options: PublicCommentQueryOptions): Promise<PublicCommentQueryPage> {
    const { limit, after, lower, upper } = publicCommentQueryOptions(options);
    return this.#queue.run(() => {
      const prefix = `${PUBLIC_COMMENT_CATALOG}/`;
      const rows = [...this.#records.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, payload]) => {
        const data = deserializeJson<PublicComment>(payload); return { id: key.slice(prefix.length), data, sortValue: publicCommentSortValue(data) };
      }).filter(row => row.sortValue >= lower && row.sortValue < upper && (!after || row.sortValue < after))
        .sort((a, b) => a.sortValue < b.sortValue ? 1 : a.sortValue > b.sortValue ? -1 : 0).slice(0, limit + 1);
      const items = rows.slice(0, limit);
      return { items, nextCursor: rows.length > limit ? publicCommentCursor(options, items.at(-1)!.sortValue) : null };
    });
  }
  list<T>(collection: string, options?: { limit?: number; cursor?: string }): Promise<{ items: { id: string; data: T }[]; nextCursor: string | null }> {
    const { limit, after } = listOptions(collection, options);
    return this.#queue.run(() => {
      const prefix = `${collection}/`;
      const selected = [...this.#records.keys()].filter(key => key.startsWith(prefix) && key.slice(prefix.length) > after).sort().slice(0, limit + 1);
      const items = selected.slice(0, limit).map(key => ({ id: key.slice(prefix.length), data: deserializeJson<T>(this.#records.get(key)!) }));
      return { items, nextCursor: selected.length > limit ? makeCursor(collection, items[items.length - 1]!.id) : null };
    });
  }
  transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.#queue.run(async () => {
      const tx = new BufferedTransaction(async key => this.#records.get(key) ?? null);
      try {
        const result = await callback(tx);
        for (const { key, payload, expiresAt } of tx.finish()) {
          if (payload === null) this.#records.delete(key); else this.#records.set(key, payload);
          if (payload !== null && typeof expiresAt === 'number') this.#expiries.set(key, expiresAt); else this.#expiries.delete(key);
        }
        return result;
      } catch (error) { tx.discard(); throw error; }
    });
  }
}
