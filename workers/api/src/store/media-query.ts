import { StoreError, validateKey } from './types';
export type MediaSort = 'created' | 'name' | 'size';
export interface MediaQueryOptions { sort: MediaSort; direction: 'asc' | 'desc'; limit?: number; cursor?: string }
export interface MediaQueryPage<T> { items: Array<{ id: string; data: T; sortValue: string }>; nextCursor: string | null }
export function mediaSortValue(value: Record<string, unknown>, sort: MediaSort): string {
  const id = String(value.id), variants = Array.isArray(value.variants) ? value.variants : [];
  const total = Number(value.originalBytes || 0) + variants.reduce((sum, item) => sum + Number(item?.bytes || 0), 0);
  const key = sort === 'created' ? String(value.createdAt || '') : sort === 'name' ? String(value.originalName || '').toLowerCase() : String(total).padStart(16, '0');
  // Filenames cannot contain control characters. A non-NUL separator also
  // round-trips through SQLite's Node string binding without truncation.
  return `${key}\u0001${id}`;
}
export function mediaCatalog(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.originalBytes !== 'number' || typeof row.createdAt !== 'string' || !['image', 'audio', 'video', 'file'].includes(String(row.kind))) return null;
  return { ...row, version: Number(row.version || 1), category: typeof row.category === 'string' ? row.category : '', lifecycle: row.lifecycle || 'active', totalBytes: Number(row.originalBytes) + (Array.isArray(row.variants) ? row.variants.reduce((sum, item) => sum + Number(item?.bytes || 0), 0) : 0) };
}
export function mediaQueryOptions(options: MediaQueryOptions): { limit: number; after: string } {
  if (!['created', 'name', 'size'].includes(options.sort) || !['asc', 'desc'].includes(options.direction)) throw new StoreError('STORE_INVALID_KEY');
  const limit = options.limit ?? 48;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new StoreError('STORE_INVALID_KEY');
  if (!options.cursor) return { limit, after: '' };
  try {
    if (!/^[A-Za-z0-9_-]{1,4096}$/u.test(options.cursor)) throw new Error();
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(options.cursor.replace(/-/gu, '+').replace(/_/gu, '/')), c => c.charCodeAt(0))));
    if (parsed.v !== 1 || parsed.sort !== options.sort || parsed.direction !== options.direction || typeof parsed.value !== 'string' || parsed.value.length > 1500 || Object.keys(parsed).length !== 4) throw new Error();
    validateKey(`media_catalog/${parsed.value.split('\u0001').at(-1)}`);
    return { limit, after: parsed.value };
  } catch { throw new StoreError('STORE_INVALID_KEY'); }
}
export function mediaCursor(options: Pick<MediaQueryOptions, 'sort' | 'direction'>, value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ v: 1, sort: options.sort, direction: options.direction, value })))).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
