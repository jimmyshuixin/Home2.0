import { z } from 'zod';
import { IdSchema } from '@xvyin/contracts';
import type { Store, Transaction } from './store/types';
import { assert } from './errors';
export interface DraftRecord<T = unknown> {
  id: string; version: number; draft: T; visibility: 'draft' | 'published' | 'hidden';
  draftRevisionId: string; lastPublishedRevisionId: string | null; createdAt: string; updatedAt: string;
}
export interface Revision<T = unknown> { id: string; entryId: string; collection: string; data: T; createdAt: string; authorUid: string; version: number }
export const STATISTIC_KEYS = ['creations', 'albums', 'fitness', 'playlists', 'commentsPending', 'contacts'] as const;
export type StatisticKey = typeof STATISTIC_KEYS[number];
const count = z.number().int().nonnegative().safe();
const StatisticsSchema = z.object({ schemaVersion: z.literal(1), version: z.number().int().positive().safe(), initializedAt: z.iso.datetime(), updatedAt: z.iso.datetime(), counts: z.object({ creations: count, albums: count, fitness: count, playlists: count, commentsPending: count, contacts: count }).strict() }).strict();
export type StatisticsProjection = z.infer<typeof StatisticsSchema>;
export function parseStatistics(value: unknown): StatisticsProjection | null { const parsed = StatisticsSchema.safeParse(value); return parsed.success ? parsed.data : null; }
/** Read this before any transaction writes. Missing means unknown, never zero. */
export async function readStatistics(tx: Pick<Transaction, 'get'>): Promise<StatisticsProjection | null> { return parseStatistics(await tx.get('system/statistics')); }
export function writeStatisticsDelta(tx: Transaction, current: StatisticsProjection | null, delta: Partial<Record<StatisticKey, number>>, at: string): void {
  if (!current) return;
  const counts = { ...current.counts };
  for (const key of STATISTIC_KEYS) { counts[key] += delta[key] || 0; assert(Number.isSafeInteger(counts[key]) && counts[key] >= 0, 'STATISTICS_RECONCILIATION_REQUIRED', 503, '计数需要校正后再继续此操作'); }
  tx.put('system/statistics', StatisticsSchema.parse({ ...current, counts, version: current.version + 1, updatedAt: at }));
}
/** One bounded page per runner invocation; do not loop across all pages in a Worker request. */
export async function statisticsRebuildPage(store: Store, collection: 'creations' | 'albums' | 'fitness' | 'playlists' | 'comments' | 'contacts', cursor?: string): Promise<{ key: StatisticKey; count: number; scanned: number; nextCursor: string | null }> {
  const page = await store.list<{ status?: string }>(collection, { limit: 50, cursor });
  return { key: collection === 'comments' ? 'commentsPending' : collection, count: page.items.filter(item => collection !== 'comments' || item.data.status === 'pending').length, scanned: page.items.length, nextCursor: page.nextCursor };
}
/** Explicit operator bootstrap/rebuild only. Pause writes during an uninitialized rebuild. */
export async function installStatisticsProjection(store: Store, counts: StatisticsProjection['counts'], expectedVersion: number | null, now: number): Promise<StatisticsProjection> {
  const at = new Date(now).toISOString();
  return store.transaction(async tx => {
    const current = await readStatistics(tx);
    assert((current?.version || null) === expectedVersion, 'VERSION_CONFLICT', 409, '校正期间计数已改变，请重新扫描');
    const next = StatisticsSchema.parse({ schemaVersion: 1, version: (current?.version || 0) + 1, initializedAt: current?.initializedAt || at, updatedAt: at, counts });
    tx.put('system/statistics', next); return next;
  });
}
export class Records {
  constructor(private readonly store: Store, private readonly now: () => number) {}
  async save<T>(collection: string, schema: z.ZodType<T>, input: unknown, authorUid: string, id: string = crypto.randomUUID(), expectedVersion = 0): Promise<DraftRecord<T>> {
    IdSchema.parse(id); const draft = schema.parse(input), timestamp = new Date(this.now()).toISOString(), revisionId = crypto.randomUUID();
    return this.store.transaction(async tx => {
      const existing = await tx.get<DraftRecord<T>>(`${collection}/${id}`);
      assert((existing?.version || 0) === expectedVersion, 'VERSION_CONFLICT', 409, '内容已在另一页面更新，请重新载入并合并');
      const counted = !existing && ['creations', 'albums', 'fitness', 'playlists'].includes(collection);
      const statistics = counted ? await readStatistics(tx) : null;
      const next: DraftRecord<T> = { id, version: expectedVersion + 1, draft, visibility: existing?.visibility || 'draft', draftRevisionId: revisionId, lastPublishedRevisionId: existing?.lastPublishedRevisionId || null, createdAt: existing?.createdAt || timestamp, updatedAt: timestamp };
      tx.put(`${collection}/${id}`, next);
      tx.put(`revisions/${revisionId}`, { id: revisionId, entryId: id, collection, data: draft, createdAt: timestamp, authorUid, version: next.version } satisfies Revision<T>);
      tx.put(`audit/${crypto.randomUUID()}`, { action: 'draft_saved', collection, entryId: id, revisionId, authorUid, at: timestamp });
      if (counted) writeStatisticsDelta(tx, statistics, { [collection]: 1 }, timestamp);
      return next;
    });
  }
}
