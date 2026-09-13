import type { ReleaseJob } from './api';
export type ReleaseCollection = 'creations' | 'albums' | 'fitness' | 'playlists' | 'settings';
export interface ReleaseChange { collection: ReleaseCollection; id: string; version: number; action: 'publish' | 'hide' }
export interface ReleaseCandidate { collection: ReleaseCollection; id: string; title: string; version: number; draftRevisionId: string; publishedRevisionId: string | null; changeKind: 'new' | 'modified' | 'hidden' | 'unchanged'; actions: Array<'publish' | 'hide'>; updatedAt?: string }
export const releaseCollections: ReleaseCollection[] = ['creations', 'albums', 'fitness', 'playlists', 'settings'];
export const collectionLabels: Record<ReleaseCollection, string> = { creations: '创作', albums: '摄影', fitness: '健身', playlists: '歌单', settings: '设置' };
export const changeLabels = { new: '新草稿', modified: '有未发布修改', hidden: '已隐藏', unchanged: '与公开版本一致' };
export const MAX_RELEASE_CHANGES = 50;
export function changeKey(value: { collection: string; id: string }): string { return `${value.collection}/${value.id}`; }
export function isPending(item: ReleaseCandidate): boolean { return item.changeKind === 'new' || item.changeKind === 'modified'; }
export function selectionChanges(items: ReleaseCandidate[], selected: Record<string, 'publish' | 'hide'>): ReleaseChange[] {
  return items.filter(item => selected[changeKey(item)] && item.actions.includes(selected[changeKey(item)]!)).map(item => ({ collection: item.collection, id: item.id, version: item.version, action: selected[changeKey(item)]! }));
}
export function releaseSignature(changes: ReleaseChange[], activeId: string | null): string { return JSON.stringify([activeId, changes.map(item => [item.collection, item.id, item.version, item.action]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]); }
export function releaseNeedsPolling(job: ReleaseJob | null): boolean {
  if (!job) return false;
  if (job.status === 'queued' && job.dispatchState === 'unconfirmed') return false;
  if (job.status === 'live') return job.reconciliationPending === true || (job.reconciledRecords !== undefined && job.reconciledRecords < (job.changes?.length ?? 0));
  return !['ready', 'active', 'published', 'failed', 'cancelled', 'superseded'].includes(job.status);
}
