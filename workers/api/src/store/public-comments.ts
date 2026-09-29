import { ApiError } from '../errors';
import { StoreError, makeCursor, type Store } from './types';
import { PUBLIC_COMMENT_CATALOG, commentTargetPrefix, decodeCommentCursor, encodeCommentCursor, publicCommentCatalog, publicCommentQueryOptions, type PublicComment, type PublicCommentQueryOptions } from './public-comment-query';

export const PUBLIC_COMMENT_CATALOG_STATE = 'system/public_comment_catalog_v1';
export interface CommentCatalogState { ready: boolean; processed: number; cursor: string | null; version: number }
export interface PublicCommentsPage { items: Array<Pick<PublicComment, 'id' | 'nickname' | 'body' | 'createdAt'>>; nextCursor: string | null; catalogReady: boolean }
const initialState = (): CommentCatalogState => ({ ready: false, processed: 0, cursor: null, version: 0 });
const publicFields = ({ id, nickname, body, createdAt }: PublicComment) => ({ id, nickname, body, createdAt });

/** New writes maintain the catalog atomically. Reads retain legacy behavior until all old rows are migrated. */
export class PublicComments {
  constructor(readonly store: Store) {}
  async catalogStatus(): Promise<CommentCatalogState> { return await this.store.get<CommentCatalogState>(PUBLIC_COMMENT_CATALOG_STATE) ?? initialState(); }
  async advanceCatalog(): Promise<CommentCatalogState> {
    const state = await this.catalogStatus();
    if (state.ready) return state;
    const page = await this.store.list<unknown>('public_comments', { limit: 5, ...(state.cursor ? { cursor: state.cursor } : {}) });
    return this.store.transaction(async tx => {
      const current = await tx.get<CommentCatalogState>(PUBLIC_COMMENT_CATALOG_STATE) ?? initialState();
      if (current.ready || current.version !== state.version) return current;
      // A moderator may have hidden or edited a row after the scan. Never project the stale page payload.
      const values = await Promise.all(page.items.map(row => tx.get<unknown>(`public_comments/${row.id}`)));
      for (let index = 0; index < page.items.length; index++) {
        const id = page.items[index]!.id, value = values[index];
        const projection = value === null ? null : publicCommentCatalog(value, id);
        if (projection) tx.put(`${PUBLIC_COMMENT_CATALOG}/${id}`, projection); else tx.delete(`${PUBLIC_COMMENT_CATALOG}/${id}`);
      }
      const next: CommentCatalogState = { ready: page.nextCursor === null, processed: current.processed + page.items.length, cursor: page.nextCursor, version: current.version + 1 };
      tx.put(PUBLIC_COMMENT_CATALOG_STATE, next);
      return next;
    });
  }
  async list(options: PublicCommentQueryOptions): Promise<PublicCommentsPage> {
    let limit: number;
    try { limit = publicCommentQueryOptions({ ...options, cursor: undefined }).limit; }
    catch { throw new ApiError('INVALID_COMMENT_QUERY', 422, '留言目标或每页条数无效'); }
    const state = await this.catalogStatus();
    if (state.ready) {
      try { publicCommentQueryOptions(options); } catch { throw new ApiError('INVALID_CURSOR', 422, '留言列表已更新，请从第一页重新读取'); }
      if (!this.store.queryPublicComments) throw new StoreError('STORE_NOT_CONFIGURED');
      const page = await this.store.queryPublicComments(options);
      return { items: page.items.map(row => publicFields(row.data)), nextCursor: page.nextCursor, catalogReady: true };
    }
    // Keep the previous ID-ordered bounded scan during migration. Do not claim this is newest-first yet.
    let legacyCursor: string | undefined;
    if (options.cursor !== undefined) {
      try {
        const cursor = decodeCommentCursor(options.cursor);
        if (Object.keys(cursor).length !== 5 || cursor.v !== 1 || cursor.mode !== 'legacy' || cursor.targetType !== options.targetType || cursor.targetId !== options.targetId || typeof cursor.value !== 'string') throw new Error();
        legacyCursor = cursor.value;
      } catch { throw new ApiError('INVALID_CURSOR', 422, '留言分页位置无效，请刷新列表'); }
    }
    let page: Awaited<ReturnType<Store['list']>>;
    try { page = await this.store.list<unknown>('public_comments', { limit: 50, ...(legacyCursor ? { cursor: legacyCursor } : {}) }); }
    catch (error) { if (error instanceof StoreError && error.code === 'STORE_INVALID_KEY') throw new ApiError('INVALID_CURSOR', 422, '留言分页位置无效，请刷新列表'); throw error; }
    const items: PublicCommentsPage['items'] = [];
    let next: string | null = page.nextCursor;
    for (let index = 0; index < page.items.length; index++) {
      const row = page.items[index]!, projected = publicCommentCatalog(row.data, row.id);
      if (projected && commentTargetPrefix(projected) === commentTargetPrefix(options)) items.push(publicFields(projected));
      if (items.length === limit) { next = index < page.items.length - 1 || page.nextCursor ? makeCursor('public_comments', row.id) : null; break; }
    }
    return { items, nextCursor: next ? encodeCommentCursor({ v: 1, targetType: options.targetType, targetId: options.targetId, mode: 'legacy', value: next }) : null, catalogReady: false };
  }
}
