import { readBoundedJson } from './google-oauth';
import { BufferedTransaction, deserializeJson, listOptions, makeCursor, MAX_STORED_JSON_BYTES, StoreError, validateKey, validateKeys, type Store, type Transaction } from './types';

const FIRESTORE_ORIGIN = 'https://firestore.googleapis.com';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const QUERY_BATCH_SIZE = 5;
type RecordObject = Record<string, unknown>;
function isObject(value: unknown): value is RecordObject { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
class TransactionAborted extends StoreError { constructor() { super('STORE_CONFLICT'); } }

export interface FirestoreConfig {
  projectId: string;
  databaseId: string;
  /** Explicitly confirmed Standard/Native database. Other editions require a separate verified adapter. */
  edition: 'standard';
  collectionPrefix?: string;
}
export interface FirestoreDependencies {
  getAccessToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxAttempts?: number;
}

/** New v3_ collections only. Never reads or mutates the legacy guestbook/blog_comments collections. */
export class FirestoreStore implements Store {
  readonly #documents: string;
  readonly #prefix: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #getAccessToken: () => Promise<string>;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  constructor(config: FirestoreConfig, dependencies: FirestoreDependencies) {
    if (!config || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(config.projectId)
      || !/^(?:\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/u.test(config.databaseId)
      || config.edition !== 'standard' || typeof dependencies?.getAccessToken !== 'function') throw new StoreError('STORE_NOT_CONFIGURED');
    this.#prefix = config.collectionPrefix ?? 'v3_';
    if (!/^v3_[a-z0-9_]{0,20}$/u.test(this.#prefix)) throw new StoreError('STORE_NOT_CONFIGURED');
    this.#documents = `projects/${config.projectId}/databases/${config.databaseId}/documents`;
    this.#fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.#getAccessToken = dependencies.getAccessToken;
    this.#timeoutMs = dependencies.timeoutMs ?? 15_000;
    this.#maxAttempts = dependencies.maxAttempts ?? 4;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 30_000
      || !Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > 5) throw new StoreError('STORE_NOT_CONFIGURED');
  }
  #name(key: string): string {
    const { collection, id } = validateKey(key);
    return `${this.#documents}/${this.#prefix}${collection}/${id}`;
  }
  async #request(operation: 'beginTransaction' | 'batchGet' | 'commit' | 'rollback' | 'runQuery', body: unknown, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const token = await this.#getAccessToken();
      if (typeof token !== 'string' || !token || token.length > 16_384 || /\s/u.test(token)) throw new StoreError('STORE_NOT_CONFIGURED');
      const serialized = JSON.stringify(body);
      if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) throw new StoreError('STORE_INVALID_VALUE');
      const response = await this.#fetch(`${FIRESTORE_ORIGIN}/v1/${this.#documents}:${operation}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: serialized, signal: controller.signal, redirect: 'error', cache: 'no-store',
      });
      const result = await readBoundedJson(response, maxBytes);
      if (!response.ok) {
        if (response.status === 409 && isObject(result) && isObject(result.error) && result.error.status === 'ABORTED') throw new TransactionAborted();
        throw new StoreError(response.status === 409 ? 'STORE_CONFLICT' : 'STORE_UNAVAILABLE');
      }
      return result;
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError('STORE_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  }
  #payload(document: unknown, expectedName: string): string {
    if (!isObject(document) || document.name !== expectedName || !isObject(document.fields)
      || !isObject(document.fields.record_json) || typeof document.fields.record_json.stringValue !== 'string'
      || !isObject(document.fields.schema_version) || document.fields.schema_version.integerValue !== '1') throw new StoreError('STORE_UNAVAILABLE');
    const payload = document.fields.record_json.stringValue;
    if (new TextEncoder().encode(payload).byteLength > MAX_STORED_JSON_BYTES) throw new StoreError('STORE_UNAVAILABLE');
    return payload;
  }
  async #readMany(keys: readonly string[], transaction?: string): Promise<Array<string | null>> {
    const checked = validateKeys(keys);
    if (!checked.length) return [];
    const names = checked.map(key => this.#name(key)), documents = [...new Set(names)], expected = new Set(documents);
    const result = await this.#request('batchGet', { documents, ...(transaction ? { transaction } : {}) }, documents.length === 1 ? 3 * 1024 * 1024 : MAX_RESPONSE_BYTES);
    if (!Array.isArray(result) || !result.every(isObject)) throw new StoreError('STORE_UNAVAILABLE');
    const found = new Map<string, string | null>();
    for (const item of result) {
      if (!('found' in item || 'missing' in item)) {
        if (Object.keys(item).some(key => key !== 'readTime' && key !== 'transaction')) throw new StoreError('STORE_UNAVAILABLE');
        continue;
      }
      if ('found' in item && 'missing' in item) throw new StoreError('STORE_UNAVAILABLE');
      const name = 'missing' in item ? item.missing : isObject(item.found) ? item.found.name : undefined;
      if (typeof name !== 'string' || !expected.has(name) || found.has(name)) throw new StoreError('STORE_UNAVAILABLE');
      found.set(name, 'missing' in item ? null : this.#payload(item.found, name));
    }
    if (found.size !== expected.size) throw new StoreError('STORE_UNAVAILABLE');
    return names.map(name => found.get(name)!);
  }
  async #read(key: string, transaction?: string): Promise<string | null> {
    return (await this.#readMany([key], transaction))[0]!;
  }
  async get<T>(key: string): Promise<T | null> {
    const payload = await this.#read(key);
    return payload === null ? null : deserializeJson<T>(payload);
  }
  async getMany<T>(keys: readonly string[]): Promise<Array<T | null>> {
    return (await this.#readMany(keys)).map(payload => payload === null ? null : deserializeJson<T>(payload));
  }
  async list<T>(collection: string, options?: { limit?: number; cursor?: string }): Promise<{ items: { id: string; data: T }[]; nextCursor: string | null }> {
    const { limit, after } = listOptions(collection, options);
    const items: Array<{ id: string; data: T }> = [];
    let cursor = after;
    let readTime: string | undefined;
    while (items.length < limit + 1) {
      const batchSize = Math.min(QUERY_BATCH_SIZE, limit + 1 - items.length);
      const result = await this.#request('runQuery', {
        structuredQuery: {
          from: [{ collectionId: `${this.#prefix}${collection}` }],
          orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: batchSize,
          ...(cursor ? { startAt: { values: [{ referenceValue: this.#name(`${collection}/${cursor}`) }], before: false } } : {}),
        }, ...(readTime ? { readTime } : {}),
      });
      if (!Array.isArray(result) || !result.every(isObject)) throw new StoreError('STORE_UNAVAILABLE');
      const rows = result.filter(item => 'document' in item);
      if (rows.length > batchSize) throw new StoreError('STORE_UNAVAILABLE');
      const lastTime = [...result].reverse().find(item => typeof item.readTime === 'string')?.readTime;
      if (!readTime && typeof lastTime === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(lastTime)) readTime = lastTime;
      if (!readTime) throw new StoreError('STORE_UNAVAILABLE');
      for (const row of rows) {
        if (!isObject(row.document) || typeof row.document.name !== 'string') throw new StoreError('STORE_UNAVAILABLE');
        const prefix = `${this.#documents}/${this.#prefix}${collection}/`;
        if (!row.document.name.startsWith(prefix)) throw new StoreError('STORE_UNAVAILABLE');
        const id = row.document.name.slice(prefix.length);
        validateKey(`${collection}/${id}`);
        if (id <= cursor) throw new StoreError('STORE_UNAVAILABLE');
        const payload = this.#payload(row.document, this.#name(`${collection}/${id}`));
        items.push({ id, data: deserializeJson<T>(payload) }); cursor = id;
      }
      if (rows.length < batchSize) break;
    }
    const page = items.slice(0, limit);
    return { items: page, nextCursor: items.length > limit ? makeCursor(collection, page[page.length - 1]!.id) : null };
  }
  async transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> {
    let retryTransaction: string | undefined;
    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      let transaction: string | undefined;
      let tx: BufferedTransaction | undefined;
      try {
        const begin = await this.#request('beginTransaction', { options: { readWrite: retryTransaction ? { retryTransaction } : {} } }, 64 * 1024);
        if (!isObject(begin) || typeof begin.transaction !== 'string' || !/^[A-Za-z0-9+/=_-]{1,4096}$/u.test(begin.transaction)) throw new StoreError('STORE_UNAVAILABLE');
        transaction = begin.transaction;
        const token = transaction;
        tx = new BufferedTransaction(key => this.#read(key, token));
        const result = await callback(tx);
        const writes = tx.finish().map(write => write.payload === null
          ? { delete: this.#name(write.key) }
          : { update: { name: this.#name(write.key), fields: { schema_version: { integerValue: '1' }, record_json: { stringValue: write.payload } } } });
        if (writes.length > 500) throw new StoreError('STORE_INVALID_VALUE');
        // A transport error here is ambiguous. Only an explicit ABORTED response is retried.
        const committed = await this.#request('commit', { writes, transaction }, 512 * 1024);
        if (!isObject(committed) || !(Array.isArray(committed.writeResults) && committed.writeResults.length === writes.length || writes.length === 0 && committed.writeResults === undefined)
          || typeof committed.commitTime !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(committed.commitTime)) throw new StoreError('STORE_UNAVAILABLE');
        return result;
      } catch (error) {
        tx?.discard();
        if (transaction) { try { await this.#request('rollback', { transaction }, 64 * 1024); } catch { /* Preserve the original failure, never expose provider details. */ } }
        if (error instanceof TransactionAborted && attempt + 1 < this.#maxAttempts) {
          retryTransaction = transaction;
          await new Promise<void>(resolveWait => setTimeout(resolveWait, 25 * 2 ** attempt));
          continue;
        }
        throw error;
      }
    }
    throw new StoreError('STORE_CONFLICT');
  }
}
