import { StoreError, type Store } from './types';
import type { MediaQueryPage } from './media-query';
import type { PublicCommentQueryPage } from './public-comment-query';
/** Allows public immutable R2 pages to remain readable while private configuration is absent. */
export class UnconfiguredStore implements Store {
  async queryPublicComments(): Promise<PublicCommentQueryPage> { throw new StoreError('STORE_NOT_CONFIGURED'); }
  async queryMedia<T>(): Promise<MediaQueryPage<T>> { throw new StoreError('STORE_NOT_CONFIGURED'); }
  async get<T>(): Promise<T | null> { throw new StoreError('STORE_NOT_CONFIGURED'); }
  async getMany<T>(): Promise<Array<T | null>> { throw new StoreError('STORE_NOT_CONFIGURED'); }
  async list<T>(): Promise<{ items: Array<{ id: string; data: T }>; nextCursor: string | null }> { throw new StoreError('STORE_NOT_CONFIGURED'); }
  async transaction<T>(): Promise<T> { throw new StoreError('STORE_NOT_CONFIGURED'); }
}
