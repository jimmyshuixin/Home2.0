import { IdSchema } from '@xvyin/contracts';
import type { Store, Transaction } from './store/types';
import type { MediaAsset } from './media';
import { assert } from './errors';
export const MEDIA_FENCE_KEY = 'system/media_lifecycle';
export interface MediaFence { epoch: number; taskId?: string; assetId?: string; expiresAt?: number }
export function referencedMedia(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) { value.forEach(item => referencedMedia(item, result)); return result; }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if ((key === 'assetId' || key.endsWith('AssetId')) && typeof item === 'string' && item) result.add(item);
    else if (key !== 'assets') referencedMedia(item, result);
  }
  return result;
}
export function availableFence(fence: MediaFence | null, now: number): number {
  assert(!fence?.taskId || (fence.expiresAt || 0) <= now, 'MEDIA_CLEANUP_BUSY', 409, '正在检查媒体永久删除，暂时不能保存内容或生成发布；请完成、取消检查或等待检查过期。');
  return fence?.epoch || 0;
}
export async function assertMediaFence(tx: Pick<Transaction, 'get'>, now: number, expectedEpoch?: number): Promise<number> {
  const epoch = availableFence(await tx.get<MediaFence>(MEDIA_FENCE_KEY), now);
  assert(expectedEpoch === undefined || epoch === expectedEpoch, 'MEDIA_STATE_CHANGED', 409, '媒体状态在检查期间改变，请重新保存或生成预览。'); return epoch;
}
export async function validateDraftMedia(store: Store, input: unknown, now: number): Promise<number> {
  const epoch = availableFence(await store.get<MediaFence>(MEDIA_FENCE_KEY), now), ids = [...referencedMedia(input)];
  assert(ids.length <= 2000, 'MEDIA_REFERENCE_LIMIT', 422, '单次保存最多引用 2000 个不同媒体，请拆分内容后保存。');
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100); batch.forEach(id => IdSchema.parse(id));
    const assets = await store.getMany<MediaAsset>(batch.map(id => `media/${id}`));
    assert(!assets.some(asset => asset?.lifecycle === 'deleted' || asset?.lifecycle === 'purging'), 'MEDIA_DELETED', 409, '内容引用的媒体已永久删除或正在删除，请移除该引用后保存。');
  }
  return epoch;
}
