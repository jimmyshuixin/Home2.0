import { z } from 'zod';
import { IdSchema } from '@xvyin/contracts';
import { assert } from './errors';
import type { DraftRecord, Revision } from './records';
import { listOptions, type Store } from './store/types';

const collectionSchema = z.enum(['creations', 'albums', 'fitness', 'playlists']);
const cursorBase = { v: z.literal(1), collection: collectionSchema, entryId: IdSchema };
const CursorSchema = z.discriminatedUnion('mode', [
  z.object({ ...cursorBase, mode: z.literal('chain'), nextId: IdSchema, version: z.number().int().positive().safe() }).strict(),
  z.object({ ...cursorBase, mode: z.literal('legacy'), beforeVersion: z.number().int().positive().safe(), after: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/u).optional() }).strict(),
]);
type Cursor = z.infer<typeof CursorSchema>;
export type RevisionSummary = Pick<Revision, 'id' | 'entryId' | 'collection' | 'version' | 'createdAt' | 'restoredFromRevisionId'>;
const PAGE_SIZE = 10;
function encode(value: Cursor): string {
  return btoa(JSON.stringify(value)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
function decode(raw: string, collection: string, entryId: string): Cursor {
  let cursor: Cursor | undefined;
  try {
    if (/^[A-Za-z0-9_-]{1,1600}$/u.test(raw)) {
      const parsed = CursorSchema.parse(JSON.parse(atob(raw.replace(/-/gu, '+').replace(/_/gu, '/'))));
      if (parsed.mode === 'legacy' && parsed.after) listOptions('revisions', { cursor: parsed.after });
      cursor = parsed;
    }
  } catch { /* Return one public error for invalid cursors. */ }
  assert(cursor && cursor.collection === collection && cursor.entryId === entryId, 'INVALID_CURSOR', 400, '历史版本分页已失效，请重新读取');
  return cursor;
}
function summary(revision: Revision): RevisionSummary {
  return { id: revision.id, entryId: revision.entryId, collection: revision.collection, version: revision.version, createdAt: revision.createdAt, ...(revision.restoredFromRevisionId ? { restoredFromRevisionId: revision.restoredFromRevisionId } : {}) };
}

/**
 * New saves form an immutable chain. Legacy saves had no predecessor/index;
 * scan only ten old documents per explicit page rather than an unbounded query
 * or pretending that pre-upgrade history does not exist. No migration writes.
 */
export async function revisionHistoryPage(store: Store, collection: string, entryId: string, rawCursor?: string) {
  const kind = collectionSchema.parse(collection); IdSchema.parse(entryId);
  const record = await store.get<DraftRecord>(`${kind}/${entryId}`);
  assert(record, 'NOT_FOUND', 404, '内容不存在');
  let cursor: Cursor | null = rawCursor ? decode(rawCursor, kind, entryId) : { v: 1, collection: kind, entryId, mode: 'chain', nextId: record.draftRevisionId, version: record.version };
  const items: RevisionSummary[] = [];
  let scanned = 0;
  if (cursor.mode === 'chain') {
    while (cursor?.mode === 'chain' && scanned < PAGE_SIZE) {
      const revision: Revision | null = await store.get<Revision>(`revisions/${cursor.nextId}`); scanned++;
      assert(revision && revision.id === cursor.nextId && revision.collection === kind && revision.entryId === entryId && revision.version === cursor.version, 'HISTORY_INCOMPLETE', 409, '历史版本链暂时无法完整读取，请稍后重试');
      items.push(summary(revision));
      if (revision.version === 1) cursor = null;
      else if (revision.previousRevisionId) cursor = { v: 1, collection: kind, entryId, mode: 'chain', nextId: IdSchema.parse(revision.previousRevisionId), version: revision.version - 1 };
      else cursor = { v: 1, collection: kind, entryId, mode: 'legacy', beforeVersion: revision.version };
    }
  } else {
    const page = await store.list<Revision>('revisions', { limit: PAGE_SIZE, ...(cursor.after ? { cursor: cursor.after } : {}) });
    scanned = page.items.length;
    for (const { id, data } of page.items) {
      if (data.id === id && data.collection === kind && data.entryId === entryId && Number.isSafeInteger(data.version) && data.version > 0 && data.version < cursor.beforeVersion) items.push(summary(data));
    }
    cursor = page.nextCursor ? { ...cursor, after: page.nextCursor } : null;
  }
  return { items: items.sort((a, b) => b.version - a.version), nextCursor: cursor ? encode(cursor) : null, historyComplete: !cursor, scanned };
}
