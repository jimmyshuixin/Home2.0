import { BufferedTransaction, deserializeJson, listOptions, makeCursor, SerialQueue, serializeJson, validateKey, validateKeys, type Store, type Transaction } from './types';

/** Unit-test adapter only. Production and local development must select persistent storage. */
export class MemoryStore implements Store {
  readonly #records = new Map<string, string>();
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
        for (const { key, payload } of tx.finish()) {
          if (payload === null) this.#records.delete(key); else this.#records.set(key, payload);
        }
        return result;
      } catch (error) { tx.discard(); throw error; }
    });
  }
}
