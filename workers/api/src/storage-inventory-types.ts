/** Safe administrator DTOs only: no R2 object keys, cursors, metadata or credentials. */
export type InventoryCategory = 'originals' | 'variants' | 'releases' | 'snapshots' | 'other';
export interface InventoryQuantity { bytes: number; count: number }
export type InventoryTotals = Record<InventoryCategory, InventoryQuantity>;
export interface InventoryError { code: string; message: string; retryable: boolean }
export interface InventoryJobView {
  id: string; status: 'running' | 'paused' | 'failed' | 'completed' | 'limited';
  phase: 'objects' | 'release_records' | 'done'; startedAt: string; updatedAt: string; finishedAt: string | null;
  totals: InventoryTotals; total: InventoryQuantity; r2Pages: number; releaseRecords: number; attempts: number;
  keepRecent: number; busy: boolean; canAdvance: boolean; lastError: InventoryError | null;
}
export interface RetentionEntry {
  releaseId: string; releaseStatus: string | null; createdAt: string | null;
  objects: InventoryQuantity; snapshots: InventoryQuantity;
  disposition: 'protect' | 'review_only' | 'unknown'; reasons: string[];
  previousReleaseId: string | null; referencedByReleaseIds: string[]; selectedRevisionCount: number | null;
  /** Previous-release relationships are observed only; media/revision references are not audited. */
  referenceCoverage: 'unknown'; deleteAllowed: false;
}
export interface RetentionPlan {
  generatedAt: string; activeReleaseIds: string[]; activeObservedAt: string | null;
  activeObservation: 'observed' | 'absent' | 'unknown'; metadataComplete: boolean; objectScanComplete: boolean;
  releaseGroupsTruncated: boolean; recentPolicyComplete: boolean; keepRecent: number;
  entries: RetentionEntry[]; unknownReleaseObjects: InventoryQuantity;
  referenceCoverage: 'partial'; deleteAllowed: false;
  limitations: string[];
}
export interface StorageInventoryStatus {
  schemaVersion: 1; version: number; job: InventoryJobView | null;
  budget: { day: string; attemptsUsed: number; attemptsLimit: number; startsUsed: number; startsLimit: number; resetsAt: string };
  limits: { pageSize: number; maxR2Pages: number; maxReleaseRecords: number; maxAttempts: number };
  retention: RetentionPlan | null;
}
export interface StorageInventoryStart { expectedVersion: number; keepRecent?: number }
export interface StorageInventoryAdvance { jobId: string; expectedVersion: number }
