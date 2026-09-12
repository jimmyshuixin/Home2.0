/** Private server-side storage. Callers never expose records without public projection. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Transaction {
  /** All reads must finish before put/delete (Firestore transaction requirement). */
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): void;
  delete(key: string): void;
}
export interface Store {
  get<T>(key: string): Promise<T | null>;
  /** At most 100 keys. Results preserve input order and duplicate slots; missing records are null. */
  getMany<T>(keys: readonly string[]): Promise<Array<T | null>>;
  list<T>(collection: string, options?: { limit?: number; cursor?: string }): Promise<{ items: Array<{ id: string; data: T }>; nextCursor: string | null }>;
  /** Serializable, retries contention; callbacks must not perform external side effects. */
  transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T>;
}
export class StoreError extends Error {
  constructor(readonly code: 'STORE_UNAVAILABLE' | 'STORE_CONFLICT' | 'STORE_NOT_CONFIGURED' | 'STORE_INVALID_KEY' | 'STORE_INVALID_VALUE' | 'STORE_TRANSACTION_ORDER' | 'STORE_TRANSACTION_CLOSED', message = '数据服务暂时不可用') { super(message); this.name = 'StoreError'; }
}

export const MAX_STORED_JSON_BYTES = 900 * 1024;
export const MAX_GET_MANY_KEYS = 100;
export function validateKeys(keys: readonly string[]): string[] {
  if (!Array.isArray(keys) || keys.length > MAX_GET_MANY_KEYS) throw new StoreError('STORE_INVALID_KEY');
  const copied: string[] = [];
  for (let index = 0; index < keys.length; index++) {
    if (!Object.hasOwn(keys, index) || typeof keys[index] !== 'string') throw new StoreError('STORE_INVALID_KEY');
    validateKey(keys[index]!); copied.push(keys[index]!);
  }
  return copied;
}
export function validateCollection(collection: string): void {
  if (!/^[a-z][a-z0-9_]{0,40}$/u.test(collection)) throw new StoreError('STORE_INVALID_KEY');
}

/** No lossy JSON coercion: rejects undefined, NaN, Dates, sparse arrays, cycles, and class instances. */
export function serializeJson(value: unknown): string {
  const active = new WeakSet<object>();
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 40) throw new StoreError('STORE_INVALID_VALUE');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      // Firestore UTF-8 storage cannot round-trip lone UTF-16 surrogates.
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item)) throw new StoreError('STORE_INVALID_VALUE');
      return;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0) || (Number.isInteger(item) && !Number.isSafeInteger(item))) throw new StoreError('STORE_INVALID_VALUE');
      return;
    }
    if (typeof item !== 'object') throw new StoreError('STORE_INVALID_VALUE');
    if (active.has(item)) throw new StoreError('STORE_INVALID_VALUE');
    active.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).some(key => typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9]\d*)$/u.test(key)))) throw new StoreError('STORE_INVALID_VALUE');
        for (let index = 0; index < item.length; index++) {
          if (!Object.hasOwn(item, index)) throw new StoreError('STORE_INVALID_VALUE');
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index))!;
          if (!descriptor.enumerable || !('value' in descriptor)) throw new StoreError('STORE_INVALID_VALUE');
          visit(descriptor.value, depth + 1);
        }
      } else {
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) throw new StoreError('STORE_INVALID_VALUE');
        for (const key of Reflect.ownKeys(item)) {
          if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new StoreError('STORE_INVALID_VALUE');
          visit(key, depth + 1);
          const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
          if (!descriptor.enumerable || !('value' in descriptor)) throw new StoreError('STORE_INVALID_VALUE');
          visit(descriptor.value, depth + 1);
        }
      }
    } finally { active.delete(item); }
  }
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).byteLength > MAX_STORED_JSON_BYTES) throw new StoreError('STORE_INVALID_VALUE');
  return serialized;
}

/** T describes caller-validated business data; Store only guarantees lossless JSON. */
export function deserializeJson<T>(serialized: string): T {
  try { const value: unknown = JSON.parse(serialized); serializeJson(value); return value as T; }
  catch { throw new StoreError('STORE_UNAVAILABLE'); }
}

export function listOptions(collection: string, options: { limit?: number; cursor?: string } = {}): { limit: number; after: string } {
  validateCollection(collection);
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new StoreError('STORE_INVALID_KEY');
  if (!options.cursor) return { limit, after: '' };
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/u.test(options.cursor)) throw new Error();
    const decoded: unknown = JSON.parse(atob(options.cursor.replace(/-/gu, '+').replace(/_/gu, '/')));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();
    const data = decoded as Record<string, unknown>;
    if (data.v !== 1 || data.collection !== collection || typeof data.id !== 'string' || Object.keys(data).length !== 3) throw new Error();
    validateKey(`${collection}/${data.id}`);
    return { limit, after: data.id };
  } catch { throw new StoreError('STORE_INVALID_KEY'); }
}
export function makeCursor(collection: string, id: string): string {
  validateKey(`${collection}/${id}`);
  return btoa(JSON.stringify({ v: 1, collection, id })).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();
  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

export type BufferedWrite = { key: string; payload: string | null };
/** Gives all adapters the same read-before-write and post-callback invalidation semantics. */
export class BufferedTransaction implements Transaction {
  readonly #writes = new Map<string, BufferedWrite>();
  #writing = false;
  #reading = 0;
  #closed = false;
  constructor(private readonly read: (key: string) => Promise<string | null>) {}
  #assertOpen(): void { if (this.#closed) throw new StoreError('STORE_TRANSACTION_CLOSED'); }
  async get<T>(key: string): Promise<T | null> {
    this.#assertOpen(); validateKey(key);
    if (this.#writing) throw new StoreError('STORE_TRANSACTION_ORDER', '事务必须先完成全部读取再写入');
    this.#reading++;
    try { const payload = await this.read(key); return payload === null ? null : deserializeJson<T>(payload); }
    finally { this.#reading--; }
  }
  #startWrite(key: string): void {
    this.#assertOpen(); validateKey(key);
    if (this.#reading) throw new StoreError('STORE_TRANSACTION_ORDER', '事务必须先等待全部读取完成');
    this.#writing = true;
  }
  put(key: string, value: unknown): void { this.#startWrite(key); this.#writes.set(key, { key, payload: serializeJson(value) }); }
  delete(key: string): void { this.#startWrite(key); this.#writes.set(key, { key, payload: null }); }
  finish(): BufferedWrite[] {
    this.#assertOpen(); this.#closed = true;
    if (this.#reading) throw new StoreError('STORE_TRANSACTION_ORDER');
    return [...this.#writes.values()];
  }
  discard(): void { this.#closed = true; this.#writes.clear(); }
}
export function validateKey(key: string): { collection: string; id: string } {
  const match = /^([a-z][a-z0-9_]{0,40})\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/u.exec(key);
  if (!match) throw new StoreError('STORE_INVALID_KEY');
  return { collection: match[1]!, id: match[2]! };
}
