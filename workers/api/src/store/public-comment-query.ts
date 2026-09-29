import { StoreError, validateKey } from './types';

export type CommentTargetType = 'guestbook' | 'creation' | 'album';
export interface PublicCommentTarget { targetType: CommentTargetType; targetId: string | null }
export interface PublicComment extends PublicCommentTarget { id: string; nickname: string; body: string; createdAt: string; status: 'approved' }
export interface PublicCommentQueryOptions extends PublicCommentTarget { limit?: number; cursor?: string }
export interface PublicCommentQueryPage { items: Array<{ id: string; data: PublicComment; sortValue: string }>; nextCursor: string | null }
export const PUBLIC_COMMENT_CATALOG = 'public_comment_catalog';
export const MAX_PUBLIC_COMMENT_BYTES = 16 * 1024;

export function commentTargetPrefix(target: PublicCommentTarget): string {
  if (!['guestbook', 'creation', 'album'].includes(target.targetType)) throw new StoreError('STORE_INVALID_KEY');
  if (target.targetType === 'guestbook') {
    if (target.targetId !== null) throw new StoreError('STORE_INVALID_KEY');
  } else {
    if (typeof target.targetId !== 'string') throw new StoreError('STORE_INVALID_KEY');
    validateKey(`comments/${target.targetId}`);
  }
  return `${target.targetType}\u0001${target.targetId ?? ''}\u0001`;
}

/** Whitelist only public fields; malformed approved legacy rows stop migration rather than disappear. */
export function publicCommentCatalog(value: unknown, id: string): PublicComment | null {
  validateKey(`public_comments/${id}`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StoreError('STORE_INVALID_VALUE');
  const row = value as Record<string, unknown>;
  if (row.status !== 'approved') return null;
  if (row.id !== id || typeof row.nickname !== 'string' || typeof row.body !== 'string' || typeof row.createdAt !== 'string') throw new StoreError('STORE_INVALID_VALUE');
  const date = new Date(row.createdAt);
  if (!Number.isFinite(date.getTime()) || !/^\d{4}-\d\d-\d\dT/u.test(row.createdAt)) throw new StoreError('STORE_INVALID_VALUE');
  const projection: PublicComment = { id, nickname: row.nickname, body: row.body, targetType: row.targetType as CommentTargetType, targetId: row.targetId as string | null, createdAt: date.toISOString(), status: 'approved' };
  commentTargetPrefix(projection);
  if (new TextEncoder().encode(JSON.stringify(projection)).byteLength > MAX_PUBLIC_COMMENT_BYTES) throw new StoreError('STORE_INVALID_VALUE');
  return projection;
}

/** One indexed field contains the target and unique newest-first position; no composite index is required. */
export function publicCommentSortValue(value: PublicComment): string {
  validateKey(`public_comments/${value.id}`);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))) throw new StoreError('STORE_INVALID_VALUE');
  return `${commentTargetPrefix(value)}${value.createdAt}\u0001${value.id}`;
}

export function encodeCommentCursor(value: Record<string, unknown>): string {
  return btoa(JSON.stringify(value)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
export function decodeCommentCursor(cursor: string): Record<string, unknown> {
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/u.test(cursor)) throw new Error();
    const value: unknown = JSON.parse(atob(cursor.replace(/-/gu, '+').replace(/_/gu, '/')));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new StoreError('STORE_INVALID_KEY'); }
}
export function publicCommentCursor(target: PublicCommentTarget, value: string): string {
  return encodeCommentCursor({ v: 1, targetType: target.targetType, targetId: target.targetId, mode: 'newest', value });
}
export function publicCommentQueryOptions(options: PublicCommentQueryOptions): { limit: number; after: string; lower: string; upper: string } {
  const lower = commentTargetPrefix(options), upper = `${lower}\uffff`, limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new StoreError('STORE_INVALID_KEY');
  if (options.cursor === undefined) return { limit, after: '', lower, upper };
  const cursor = decodeCommentCursor(options.cursor);
  if (Object.keys(cursor).length !== 5 || cursor.v !== 1 || cursor.targetType !== options.targetType || cursor.targetId !== options.targetId || cursor.mode !== 'newest' || typeof cursor.value !== 'string' || !cursor.value.startsWith(lower)) throw new StoreError('STORE_INVALID_KEY');
  const parts = cursor.value.slice(lower.length).split('\u0001');
  if (parts.length !== 2 || publicCommentSortValue({ ...options, id: parts[1]!, createdAt: parts[0]!, status: 'approved', nickname: '', body: '' }) !== cursor.value) throw new StoreError('STORE_INVALID_KEY');
  return { limit, after: cursor.value, lower, upper };
}
