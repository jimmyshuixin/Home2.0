import { StoreError } from './types';

export const EXPIRY_COLLECTIONS = ['sessions', 'rates', 'idempotency'] as const;
export type ExpiryCollection = typeof EXPIRY_COLLECTIONS[number];
export interface ExpiredQueryOptions { expiresBefore: number; limit?: number }
export interface ExpiredQueryPage { items: Array<{ id: string; expiresAt: number }>; hasMore: boolean }
export function expiryCollection(value: string): ExpiryCollection {
  if (!(EXPIRY_COLLECTIONS as readonly string[]).includes(value)) throw new StoreError('STORE_INVALID_KEY');
  return value as ExpiryCollection;
}
/** Invalid/missing values are retained and never indexed for automatic deletion. */
export function recordExpiry(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const expiry = (value as Record<string, unknown>).expiresAt;
  return typeof expiry === 'number' && Number.isSafeInteger(expiry) && expiry > 0 && expiry <= 8_640_000_000_000_000 ? expiry : null;
}
export function expiryProjection(key: string, value: unknown): number | null {
  return (EXPIRY_COLLECTIONS as readonly string[]).includes(key.split('/')[0]!) ? recordExpiry(value) : null;
}
export function expiredQueryOptions(collection: string, options: ExpiredQueryOptions): { collection: ExpiryCollection; limit: number; expiresBefore: number } {
  const checked = expiryCollection(collection), limit = options.limit ?? 5;
  if (!Number.isSafeInteger(options.expiresBefore) || options.expiresBefore < 0 || options.expiresBefore > 8_640_000_000_000_000 || !Number.isInteger(limit) || limit < 1 || limit > 5) throw new StoreError('STORE_INVALID_KEY');
  return { collection: checked, limit, expiresBefore: options.expiresBefore };
}
