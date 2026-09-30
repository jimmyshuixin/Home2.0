import type { Collection } from './api';
export interface EditorSnapshot { draft: Record<string, unknown>; tagText: string; sourceText: string }
export interface RecoverySource { entryId: string; tabId: string }
export interface RecoveryRecord { schemaVersion: 1; owner: string; collection: Collection; entryId: string; tabId: string; baseVersion: number; updatedAt: number; snapshot: EditorSnapshot }
type StorageLike = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
const PREFIX = 'xvyin:private-draft:v1:';
export const RECOVERY_TTL = 7 * 86400_000;
export const MAX_RECOVERY_BYTES = 1_500_000;
export const AUTOSAVE_DELAY = 30_000;
export function recoveryKey(owner: string, collection: Collection, entryId: string, tabId: string) { return `${PREFIX}${encodeURIComponent(owner)}:${collection}:${encodeURIComponent(entryId)}:${tabId}`; }
export function parseRecovery(raw: string | null, now = Date.now()): RecoveryRecord | null {
  if (!raw || raw.length > MAX_RECOVERY_BYTES) return null;
  try { const value = JSON.parse(raw) as RecoveryRecord;
    if (value.schemaVersion !== 1 || typeof value.owner !== 'string' || !['creations','albums','fitness','playlists'].includes(value.collection) || typeof value.entryId !== 'string' || typeof value.tabId !== 'string' || !Number.isInteger(value.baseVersion) || value.baseVersion < 0 || !Number.isFinite(value.updatedAt) || value.updatedAt > now + 60000 || now - value.updatedAt > RECOVERY_TTL || !value.snapshot || typeof value.snapshot.tagText !== 'string' || typeof value.snapshot.sourceText !== 'string') return null;
    const draft = value.snapshot.draft;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null;
    if (value.collection === 'creations' && (typeof draft.title !== 'string' || typeof draft.summary !== 'string' || !Array.isArray(draft.blocks) || !Array.isArray(draft.tags) || !Array.isArray(draft.sourceLinks) || !draft.seo)) return null;
    if (value.collection === 'albums' && (typeof draft.title !== 'string' || !Array.isArray(draft.photos))) return null;
    if (value.collection === 'fitness' && (typeof draft.title !== 'string' || !Array.isArray(draft.photos) || !Array.isArray(draft.tags))) return null;
    if (value.collection === 'playlists' && (typeof draft.name !== 'string' || !Array.isArray(draft.tracks))) return null;
    return value;
  } catch { return null; }
}
export function listRecovery(storage: StorageLike, owner: string, collection: Collection, entryId: string, now = Date.now()): RecoveryRecord[] {
  const output: RecoveryRecord[] = [];
  for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (!key?.startsWith(PREFIX)) continue; const value = parseRecovery(storage.getItem(key), now); if (value?.owner === owner && value.collection === collection && value.entryId === entryId) output.push(value); }
  return output.sort((a,b) => b.updatedAt - a.updatedAt).slice(0, 20);
}
export function writeRecovery(storage: StorageLike, record: RecoveryRecord) {
  const raw = JSON.stringify(record); if (new TextEncoder().encode(raw).byteLength > MAX_RECOVERY_BYTES) throw new Error('草稿较大，本机恢复空间不足。请导出草稿并手动保存。');
  const prefix = `${PREFIX}${encodeURIComponent(record.owner)}:`, ownKey = recoveryKey(record.owner,record.collection,record.entryId,record.tabId);
  let count = 0; const expired: string[] = [];
  for(let index=0;index<storage.length;index++){const key=storage.key(index);if(!key?.startsWith(prefix))continue;if(parseRecovery(storage.getItem(key),record.updatedAt))count++;else expired.push(key);}
  expired.forEach(key=>storage.removeItem(key));
  if(count>=20&&!storage.getItem(ownKey))throw new Error('本机已有较多恢复副本，请先导出或处理已有副本。');
  storage.setItem(ownKey, raw);
}
export function removeRecovery(storage: StorageLike, record: Pick<RecoveryRecord,'owner'|'collection'|'entryId'|'tabId'>) { storage.removeItem(recoveryKey(record.owner,record.collection,record.entryId,record.tabId)); }
/** A recovery prompt is a snapshot. Another tab may have updated that slot since. */
export function removeCapturedRecovery(storage: StorageLike, record: RecoveryRecord): boolean {
  const key=recoveryKey(record.owner,record.collection,record.entryId,record.tabId),raw=storage.getItem(key);
  if(raw!==JSON.stringify(record))return false;
  storage.removeItem(key);return true;
}
export function clearOwnerRecovery(storage: StorageLike, owner: string) {
  const prefix = `${PREFIX}${encodeURIComponent(owner)}:`; const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (key?.startsWith(prefix)) keys.push(key); } keys.forEach(key => storage.removeItem(key));
}
export function snapshotString(snapshot: EditorSnapshot) { return JSON.stringify(snapshot); }
/** A save acknowledgement only clears the exact snapshot sent by that request. */
export function acknowledgeSnapshot(sent: string, current: string) { return { dirty: sent !== current, clearRecovery: sent === current }; }
export function exportDraft(snapshot: EditorSnapshot, collection: Collection) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 1, collection, ...snapshot }, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `xvyin-${collection}-draft.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
