/** Aggregate-only admin DTO. Never includes session identifiers or record payloads. */
export interface ExpiryMaintenanceStatus {
  phase: 'backfill' | 'cleanup';
  busy: boolean;
  canAdvance: boolean;
  retryAt: string | null;
  lastResult: 'idle' | 'backfilled' | 'cleaned' | 'budget_limited' | 'busy';
  backfill: { collection: 'sessions' | 'rates' | 'idempotency' | null; completedCollections: number; scanned: number; projected: number; invalid: number };
  cleanup: { collection: 'sessions' | 'rates' | 'idempotency'; deleted: number; renewed: number; invalid: number; lastCompletedAt: string | null };
  budget: { day: string; stepsUsed: number; stepLimit: number; readUnitsReserved: number; readLimit: number; writeUnitsReserved: number; writeLimit: number; deleteUnitsReserved: number; deleteLimit: number };
  limits: { batchSize: 5; leaseSeconds: 120 };
}
