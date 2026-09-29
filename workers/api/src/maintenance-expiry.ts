import { StoreError, type Store } from './store/types';
import { EXPIRY_COLLECTIONS, recordExpiry } from './store/expiry-query';
import type { ExpiryMaintenanceStatus } from './maintenance-expiry-types';
export type { ExpiryMaintenanceStatus } from './maintenance-expiry-types';

export const EXPIRY_MAINTENANCE_STATE = 'system/expiry_maintenance_v1';
export const EXPIRY_MAINTENANCE_LIMITS = { batchSize: 5, leaseMs: 120_000, idleMs: 3600_000, dailySteps: 192, readsPerStep: 42, writesPerStep: 7, deletesPerStep: 5 } as const;
interface Budget { day: string; steps: number; reads: number; writes: number; deletes: number }
interface State {
  schemaVersion: 1;
  version: number;
  backfill: { index: number; cursor: string | null; scanned: number; projected: number; invalid: number };
  cleanup: { index: number; roundHasMore: boolean; deleted: number; renewed: number; invalid: number; notBefore: number; lastCompletedAt: string | null };
  budget: Budget;
  lease: { token: string; expiresAt: number } | null;
  lastResult: 'idle' | 'backfilled' | 'cleaned';
}
function initial(at: number): State {
  return { schemaVersion: 1, version: 0, backfill: { index: 0, cursor: null, scanned: 0, projected: 0, invalid: 0 }, cleanup: { index: 0, roundHasMore: false, deleted: 0, renewed: 0, invalid: 0, notBefore: 0, lastCompletedAt: null }, budget: { day: new Date(at).toISOString().slice(0, 10), steps: 0, reads: 0, writes: 0, deletes: 0 }, lease: null, lastResult: 'idle' };
}
function stateValue(value: unknown, at: number): State {
  if (value === null) return initial(at);
  const state = value as State;
  if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.version) || state.version < 0
    || !state.backfill || !Number.isInteger(state.backfill.index) || state.backfill.index < 0 || state.backfill.index > 3
    || !(state.backfill.cursor === null || typeof state.backfill.cursor === 'string')
    || !state.cleanup || !Number.isInteger(state.cleanup.index) || state.cleanup.index < 0 || state.cleanup.index > 2
    || !Number.isSafeInteger(state.cleanup.notBefore) || state.cleanup.notBefore < 0
    || !state.budget || !/^\d{4}-\d\d-\d\d$/u.test(state.budget.day)
    || [state.backfill.scanned, state.backfill.projected, state.backfill.invalid, state.cleanup.deleted, state.cleanup.renewed, state.cleanup.invalid, state.budget.steps, state.budget.reads, state.budget.writes, state.budget.deletes].some(count => !Number.isSafeInteger(count) || count < 0)
    || state.lease !== null && (!state.lease || typeof state.lease.token !== 'string' || !Number.isSafeInteger(state.lease.expiresAt))) throw new StoreError('STORE_UNAVAILABLE');
  return state;
}
function budgetAt(state: State, at: number): Budget {
  const day = new Date(at).toISOString().slice(0, 10);
  // Clock rollback never opens another allowance for an already consumed day.
  return day > state.budget.day ? { day, steps: 0, reads: 0, writes: 0, deletes: 0 } : { ...state.budget };
}
function status(state: State, at: number): ExpiryMaintenanceStatus {
  const limits = EXPIRY_MAINTENANCE_LIMITS, budget = budgetAt(state, at), busy = Boolean(state.lease && state.lease.expiresAt > at);
  const limited = budget.steps >= limits.dailySteps || budget.reads + limits.readsPerStep > limits.dailySteps * limits.readsPerStep || budget.writes + limits.writesPerStep > limits.dailySteps * limits.writesPerStep || budget.deletes + limits.deletesPerStep > limits.dailySteps * limits.deletesPerStep;
  const phase = state.backfill.index < 3 ? 'backfill' : 'cleanup';
  const retry = Math.max(busy ? state.lease!.expiresAt : 0, limited ? Date.parse(`${budget.day}T00:00:00.000Z`) + 86400_000 : 0, phase === 'cleanup' ? state.cleanup.notBefore : 0);
  return {
    phase, busy, canAdvance: !busy && !limited && retry <= at, retryAt: retry > at ? new Date(retry).toISOString() : null,
    lastResult: busy ? 'busy' : limited ? 'budget_limited' : state.lastResult,
    backfill: { collection: EXPIRY_COLLECTIONS[state.backfill.index] ?? null, completedCollections: state.backfill.index, scanned: state.backfill.scanned, projected: state.backfill.projected, invalid: state.backfill.invalid },
    cleanup: { collection: EXPIRY_COLLECTIONS[state.cleanup.index]!, deleted: state.cleanup.deleted, renewed: state.cleanup.renewed, invalid: state.cleanup.invalid, lastCompletedAt: state.cleanup.lastCompletedAt },
    budget: { day: budget.day, stepsUsed: budget.steps, stepLimit: limits.dailySteps, readUnitsReserved: budget.reads, readLimit: limits.dailySteps * limits.readsPerStep, writeUnitsReserved: budget.writes, writeLimit: limits.dailySteps * limits.writesPerStep, deleteUnitsReserved: budget.deletes, deleteLimit: limits.dailySteps * limits.deletesPerStep },
    limits: { batchSize: 5, leaseSeconds: 120 },
  };
}

/** One bounded page per call. No R2 operations, business collection deletion, or Firestore TTL. */
export class ExpiryMaintenance {
  constructor(readonly store: Store, readonly now: () => number = Date.now) {}
  private clock(): number {
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000 - 86400_000) throw new StoreError('STORE_INVALID_VALUE');
    return at;
  }
  async getStatus(): Promise<ExpiryMaintenanceStatus> {
    const value = await this.store.get<unknown>(EXPIRY_MAINTENANCE_STATE), at = this.clock();
    return status(stateValue(value, at), at);
  }
  async advance(): Promise<ExpiryMaintenanceStatus> {
    if (!this.store.queryExpired) throw new StoreError('STORE_NOT_CONFIGURED');
    const token = crypto.randomUUID(), limits = EXPIRY_MAINTENANCE_LIMITS;
    const claimed = await this.store.transaction(async tx => {
      const value = await tx.get<unknown>(EXPIRY_MAINTENANCE_STATE), at = this.clock(), current = stateValue(value, at);
      if (!status(current, at).canAdvance) return { current, owned: false };
      const budget = budgetAt(current, at);
      const next: State = { ...current, budget: { ...budget, steps: budget.steps + 1, reads: budget.reads + limits.readsPerStep, writes: budget.writes + limits.writesPerStep, deletes: budget.deletes + limits.deletesPerStep }, lease: { token, expiresAt: at + limits.leaseMs }, version: current.version + 1 };
      tx.put(EXPIRY_MAINTENANCE_STATE, next);
      return { current: next, owned: true };
    });
    if (!claimed.owned) return status(claimed.current, this.clock());
    const backfill = claimed.current.backfill.index < 3;
    const collection = EXPIRY_COLLECTIONS[backfill ? claimed.current.backfill.index : claimed.current.cleanup.index]!;
    const page = backfill
      ? await this.store.list<unknown>(collection, { limit: limits.batchSize, ...(claimed.current.backfill.cursor ? { cursor: claimed.current.backfill.cursor } : {}) })
      : await this.store.queryExpired(collection, { limit: limits.batchSize, expiresBefore: this.clock() });
    if (page.items.length > limits.batchSize || new Set(page.items.map(row => row.id)).size !== page.items.length) throw new StoreError('STORE_UNAVAILABLE');
    return this.store.transaction(async tx => {
      const values = await tx.getMany<unknown>([EXPIRY_MAINTENANCE_STATE, ...page.items.map(row => `${collection}/${row.id}`)]);
      const at = this.clock(), current = stateValue(values[0], at);
      if (current.lease?.token !== token || current.lease.expiresAt <= at) return status(current, at);
      let projected = 0, invalid = 0, deleted = 0, renewed = 0;
      for (let index = 0; index < page.items.length; index++) {
        const value = values[index + 1];
        if (value === null) continue;
        const key = `${collection}/${page.items[index]!.id}`, expiresAt = recordExpiry(value);
        if (expiresAt === null) { invalid++; tx.put(key, value); }
        else if (backfill) { projected++; tx.put(key, value); }
        else if (expiresAt <= at) { deleted++; tx.delete(key); }
        else { renewed++; tx.put(key, value); }
      }
      const next: State = { ...current, backfill: { ...current.backfill }, cleanup: { ...current.cleanup }, lease: null, version: current.version + 1, lastResult: backfill ? 'backfilled' : 'cleaned' };
      if (backfill) {
        const cursor = 'nextCursor' in page ? page.nextCursor : null;
        next.backfill = { index: current.backfill.index + (cursor === null ? 1 : 0), cursor, scanned: current.backfill.scanned + page.items.length, projected: current.backfill.projected + projected, invalid: current.backfill.invalid + invalid };
      } else {
        const hasMore = 'hasMore' in page && page.hasMore, finishedRound = current.cleanup.index === 2, roundHasMore = current.cleanup.roundHasMore || hasMore;
        next.cleanup = { index: finishedRound ? 0 : current.cleanup.index + 1, roundHasMore: finishedRound ? false : roundHasMore, deleted: current.cleanup.deleted + deleted, renewed: current.cleanup.renewed + renewed, invalid: current.cleanup.invalid + invalid, lastCompletedAt: finishedRound ? new Date(at).toISOString() : current.cleanup.lastCompletedAt, notBefore: finishedRound && !roundHasMore ? at + limits.idleMs : 0 };
      }
      tx.put(EXPIRY_MAINTENANCE_STATE, next);
      return status(next, at);
    });
  }
}
