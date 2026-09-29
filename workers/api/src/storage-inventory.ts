import { ApiError, assert } from './errors';
import type { Store } from './store/types';
import type { InventoryCategory, InventoryError, InventoryJobView, InventoryQuantity, InventoryTotals, RetentionEntry, RetentionPlan, StorageInventoryAdvance, StorageInventoryStart, StorageInventoryStatus } from './storage-inventory-types';
export type * from './storage-inventory-types';

export const STORAGE_INVENTORY_KEY = 'maintenance/storage_inventory';
export const STORAGE_INVENTORY_BUDGET_KEY = 'maintenance/storage_inventory_budget';
export const STORAGE_INVENTORY_LIMITS = Object.freeze({ pageSize: 100, maxR2Pages: 200, maxReleaseRecords: 200, maxAttempts: 400 });
const DAILY_ATTEMPTS = 200, DAILY_STARTS = 3, RELEASE_PAGE_SIZE = 5, MAX_GROUPS = 200, LEASE_MS = 60_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const PROTECTED_STATUSES = new Set(['queued', 'building', 'ready', 'activating', 'reconciling']);
const KNOWN_STATUSES = new Set([...PROTECTED_STATUSES, 'live', 'superseded', 'failed']);
const ROLLBACK_STATUSES = new Set(['ready', 'live', 'superseded']);
const quantity = (): InventoryQuantity => ({ bytes: 0, count: 0 });
const totals = (): InventoryTotals => ({ originals: quantity(), variants: quantity(), releases: quantity(), snapshots: quantity(), other: quantity() });
type ReleaseSummary = { id: string; status: string | null; createdAt: string | null; previousReleaseId: string | null; selectedRevisionCount: number | null };
type ReleaseGroup = { id: string; objects: InventoryQuantity; snapshots: InventoryQuantity };
type Lease = { token: string; expiresAt: number };
interface Job extends Omit<InventoryJobView, 'busy' | 'canAdvance'> {
  cursor: string | null; recordsCursor: string | null; lease: Lease | null;
  groups: ReleaseGroup[]; groupsTruncated: boolean; unknownReleaseObjects: InventoryQuantity; records: ReleaseSummary[];
  objectScanComplete: boolean; metadataComplete: boolean;
  activeReleaseIds: string[]; activeObservedAt: string | null; activeObservation: 'observed' | 'absent' | 'unknown';
}
interface State { version: number; job: Job | null }
interface Budget { day: string; attempts: number; starts: number }
type ActiveObservation = { id: string | null; observedAt: string; status: 'observed' | 'absent' };
const initialState = (): State => ({ version: 0, job: null });
function dayAt(now: number): string { return new Date(now).toISOString().slice(0, 10); }
/** One fixed record; only a later UTC day can replenish it. Clock rollback grants no new quota. */
function budgetAt(stored: Budget | null, now: number): Budget { const day = dayAt(now); return !stored || day > stored.day ? { day, attempts: 0, starts: 0 } : stored; }
function isoDate(value: unknown): string | null { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
function validId(value: unknown): value is string { return typeof value === 'string' && SAFE_ID.test(value); }
function add(target: InventoryQuantity, value: InventoryQuantity): void {
  assert(Number.isSafeInteger(value.bytes) && value.bytes >= 0 && Number.isSafeInteger(value.count) && value.count >= 0, 'INVENTORY_INVALID_PAGE', 503, '存储列表暂时无法核验，请重试');
  assert(Number.isSafeInteger(target.bytes + value.bytes) && Number.isSafeInteger(target.count + value.count), 'INVENTORY_SIZE_LIMIT', 503, '盘点结果超出可精确统计范围');
  target.bytes += value.bytes; target.count += value.count;
}
/** Prefixes are defined by Media.startUpload, Processing.plan and Releases snapshot/manifest writers. */
export function inventoryCategory(key: string): InventoryCategory {
  if (key.startsWith('originals/')) return 'originals';
  if (key.startsWith('variants/')) return 'variants';
  if (key.startsWith('releases/')) return 'releases';
  if (/^private-(?:snapshots|snapshot-sources|snapshot-preparation)\//u.test(key)) return 'snapshots';
  return 'other';
}
function groupId(key: string, category: InventoryCategory): string | null {
  const id = category === 'releases' ? key.split('/')[1] : category === 'snapshots' ? /^private-(?:snapshots|snapshot-sources|snapshot-preparation)\/([^/]+)\.json$/u.exec(key)?.[1] : null;
  return validId(id) ? id : null;
}
function summarize(id: string, value: unknown): ReleaseSummary {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { id, status: typeof record.status === 'string' && KNOWN_STATUSES.has(record.status) ? record.status : null, createdAt: isoDate(record.createdAt), previousReleaseId: validId(record.previousReleaseId) ? record.previousReleaseId : null,
    selectedRevisionCount: record.selectedRevisionIds && typeof record.selectedRevisionIds === 'object' && !Array.isArray(record.selectedRevisionIds) ? Object.keys(record.selectedRevisionIds).length : null };
}
function retention(job: Job): RetentionPlan {
  const recent = new Set([...job.records].filter(row => row.createdAt && row.status && ROLLBACK_STATUSES.has(row.status)).sort((a, b) => b.createdAt!.localeCompare(a.createdAt!) || b.id.localeCompare(a.id)).slice(0, job.keepRecent).map(row => row.id));
  const ids = new Set([...job.groups.map(row => row.id), ...job.records.map(row => row.id), ...job.records.flatMap(row => row.previousReleaseId ? [row.previousReleaseId] : []), ...job.activeReleaseIds]);
  const entries: RetentionEntry[] = [...ids].sort().map(releaseId => {
    const record = job.records.find(row => row.id === releaseId), group = job.groups.find(row => row.id === releaseId), reasons: string[] = [];
    if (job.activeReleaseIds.includes(releaseId)) reasons.push('扫描开始或结束时观察到的公开版本');
    if (record?.status && PROTECTED_STATUSES.has(record.status)) reasons.push('发布任务尚在进行或等待启用');
    if (recent.has(releaseId)) reasons.push(`保留最近 ${job.keepRecent} 个可预览或已发布版本用于回滚审查`);
    const protectedEntry = reasons.length > 0;
    if (!record) reasons.push('没有读到对应发布记录，状态及引用未知');
    else if (!record.status || !record.createdAt) reasons.push('发布记录状态或时间不完整');
    if (!job.metadataComplete) reasons.push('发布记录扫描尚未完整，最近版本及引用关系可能不全');
    if (record?.status === 'live' && !job.activeReleaseIds.includes(releaseId)) reasons.push('历史 live 状态不代表当前公开指针');
    if (!protectedEntry) reasons.push('仅供人工审查；未核查媒体、历史修订和快照引用，不表示可删除');
    return { releaseId, releaseStatus: record?.status ?? null, createdAt: record?.createdAt ?? null, objects: group?.objects ?? quantity(), snapshots: group?.snapshots ?? quantity(),
      disposition: protectedEntry ? 'protect' : !record?.status || !record.createdAt || !job.metadataComplete ? 'unknown' : 'review_only', reasons,
      previousReleaseId: record?.previousReleaseId ?? null, referencedByReleaseIds: job.records.filter(row => row.previousReleaseId === releaseId).map(row => row.id), selectedRevisionCount: record?.selectedRevisionCount ?? null,
      referenceCoverage: 'unknown', deleteAllowed: false };
  });
  return { generatedAt: job.updatedAt, activeReleaseIds: job.activeReleaseIds, activeObservedAt: job.activeObservedAt, activeObservation: job.activeObservation,
    metadataComplete: job.metadataComplete, objectScanComplete: job.objectScanComplete, releaseGroupsTruncated: job.groupsTruncated, recentPolicyComplete: job.metadataComplete && job.records.every(row => row.status !== null && (!ROLLBACK_STATUSES.has(row.status) || row.createdAt !== null)), keepRecent: job.keepRecent,
    entries, unknownReleaseObjects: job.unknownReleaseObjects, referenceCoverage: 'partial', deleteAllowed: false,
    limitations: ['这是扫描开始至结束时间窗口内的非原子盘点；并发上传、覆盖或删除可改变结果。', '仅统计已完成对象；未完成 multipart 上传及其分片不计入。', '只统计对象 payload 字节，不等同于 R2 账单 GB-month 或账户免费额度剩余。', '当前版本仅代表标注时间的指针观察；建议不是删除授权。', 'previousReleaseId 只表示观察到的前序关系；共享媒体、历史修订及快照内容引用均未完整审计。', '扫描和发布分组有明确上限；缺失或未知数据不会被视为未引用。'] };
}

/** Read-only R2 inventory. Store transactions reserve work and checkpoint it; no R2 call is inside a retryable callback. */
export class StorageInventory {
  constructor(readonly store: Store, readonly bucket: Pick<R2Bucket, 'list' | 'get'>, readonly now: () => number) {}
  async getStatus(): Promise<StorageInventoryStatus> {
    const [state, storedBudget] = await Promise.all([this.store.get<State>(STORAGE_INVENTORY_KEY), this.store.get<Budget>(STORAGE_INVENTORY_BUDGET_KEY)]), now = this.now();
    return this.#view(state ?? initialState(), budgetAt(storedBudget, now), now);
  }
  #view(state: State, budget: Budget, now: number): StorageInventoryStatus {
    const job = state.job, busy = !!job?.lease && job.lease.expiresAt > now;
    // An exhausted, expired lease still permits one zero-I/O advance to persist `limited`.
    const needsLimitCheckpoint = !!job && (job.attempts >= STORAGE_INVENTORY_LIMITS.maxAttempts || job.phase === 'objects' && job.r2Pages >= STORAGE_INVENTORY_LIMITS.maxR2Pages || job.phase === 'release_records' && job.releaseRecords >= STORAGE_INVENTORY_LIMITS.maxReleaseRecords);
    return { schemaVersion: 1, version: state.version, job: job ? {
      id: job.id, status: job.status, phase: job.phase, startedAt: job.startedAt, updatedAt: job.updatedAt, finishedAt: job.finishedAt,
      totals: job.totals, total: job.total, r2Pages: job.r2Pages, releaseRecords: job.releaseRecords, attempts: job.attempts, keepRecent: job.keepRecent,
      busy, canAdvance: !busy && !['completed', 'limited'].includes(job.status) && (needsLimitCheckpoint || budget.attempts < DAILY_ATTEMPTS),
      lastError: job.lastError } : null,
      budget: { day: budget.day, attemptsUsed: budget.attempts, attemptsLimit: DAILY_ATTEMPTS, startsUsed: budget.starts, startsLimit: DAILY_STARTS, resetsAt: new Date(Date.parse(`${budget.day}T00:00:00.000Z`) + 86_400_000).toISOString() },
      limits: STORAGE_INVENTORY_LIMITS, retention: job ? retention(job) : null };
  }
  async start(input: StorageInventoryStart): Promise<StorageInventoryStatus> {
    this.#version(input.expectedVersion);
    const keepRecent = input.keepRecent ?? 5;
    assert(Number.isInteger(keepRecent) && keepRecent >= 3 && keepRecent <= 10, 'INVALID_INVENTORY_POLICY', 422, '保留数量应为 3 至 10');
    const id = crypto.randomUUID();
    await this.store.transaction(async tx => {
      const state = await tx.get<State>(STORAGE_INVENTORY_KEY) ?? initialState(), storedBudget = await tx.get<Budget>(STORAGE_INVENTORY_BUDGET_KEY), now = this.now(), at = new Date(now).toISOString(), budget = budgetAt(storedBudget, now);
      // A repeated start response or another open administrator tab must not replace ongoing work.
      if (state.version !== input.expectedVersion || state.job && !['completed', 'limited'].includes(state.job.status)) return;
      assert(budget.starts < DAILY_STARTS && budget.attempts < DAILY_ATTEMPTS, 'INVENTORY_DAILY_BUDGET', 429, '今日盘点预算已用完，请在 UTC 次日继续');
      const job: Job = { id, status: 'running', phase: 'objects', startedAt: at, updatedAt: at, finishedAt: null, totals: totals(), total: quantity(), r2Pages: 0, releaseRecords: 0, attempts: 0, keepRecent, lastError: null,
        cursor: null, recordsCursor: null, lease: null, groups: [], groupsTruncated: false, unknownReleaseObjects: quantity(), records: [], objectScanComplete: false, metadataComplete: false,
        activeReleaseIds: [], activeObservedAt: null, activeObservation: 'unknown' };
      tx.put(STORAGE_INVENTORY_KEY, { version: state.version + 1, job });
      tx.put(STORAGE_INVENTORY_BUDGET_KEY, { ...budget, starts: budget.starts + 1 });
    });
    return this.getStatus();
  }
  async pause(input: StorageInventoryAdvance): Promise<StorageInventoryStatus> {
    this.#input(input);
    await this.store.transaction(async tx => {
      const state = await tx.get<State>(STORAGE_INVENTORY_KEY), now = this.now();
      assert(state?.job && state.job.id === input.jobId, 'INVENTORY_JOB_CHANGED', 409, '盘点任务已改变，请刷新');
      if (state.version !== input.expectedVersion || ['paused', 'completed', 'limited'].includes(state.job.status)) return;
      tx.put(STORAGE_INVENTORY_KEY, { version: state.version + 1, job: { ...state.job, status: 'paused', lease: null, updatedAt: new Date(now).toISOString() } });
    });
    return this.getStatus();
  }
  async advance(input: StorageInventoryAdvance): Promise<StorageInventoryStatus> {
    this.#input(input); const token = crypto.randomUUID();
    const claimed = await this.store.transaction(async tx => {
      const state = await tx.get<State>(STORAGE_INVENTORY_KEY), storedBudget = await tx.get<Budget>(STORAGE_INVENTORY_BUDGET_KEY), now = this.now(), budget = budgetAt(storedBudget, now);
      assert(state?.job && state.job.id === input.jobId, 'INVENTORY_JOB_CHANGED', 409, '盘点任务已改变，请刷新');
      const job = state.job;
      if (state.version !== input.expectedVersion || ['completed', 'limited'].includes(job.status) || job.lease && job.lease.expiresAt > now) return null;
      let problem: InventoryError | null = null;
      if (job.attempts >= STORAGE_INVENTORY_LIMITS.maxAttempts || job.phase === 'objects' && job.r2Pages >= STORAGE_INVENTORY_LIMITS.maxR2Pages || job.phase === 'release_records' && job.releaseRecords >= STORAGE_INVENTORY_LIMITS.maxReleaseRecords) problem = { code: 'INVENTORY_RUN_LIMIT', message: '本轮盘点已达到上限，结果为部分统计；未知引用仍需人工核查', retryable: false };
      else if (budget.attempts >= DAILY_ATTEMPTS) problem = { code: 'INVENTORY_DAILY_BUDGET', message: '今日盘点预算已用完，请在 UTC 次日继续', retryable: true };
      if (problem) {
        tx.put(STORAGE_INVENTORY_KEY, { version: state.version + 1, job: { ...job, status: problem.retryable ? 'paused' : 'limited', lease: null, lastError: problem, updatedAt: new Date(now).toISOString(), finishedAt: problem.retryable ? null : new Date(now).toISOString() } });
        return null;
      }
      const next: Job = { ...job, status: 'running', lease: { token, expiresAt: now + LEASE_MS }, attempts: job.attempts + 1, lastError: null };
      tx.put(STORAGE_INVENTORY_KEY, { version: state.version, job: next });
      tx.put(STORAGE_INVENTORY_BUDGET_KEY, { ...budget, attempts: budget.attempts + 1 });
      return next;
    });
    if (!claimed) return this.getStatus();
    try {
      let active: ActiveObservation | undefined;
      // Lists provide size directly. Never retrieve object bodies or issue per-object HEAD requests.
      const updated = structuredClone(claimed);
      if (claimed.phase === 'objects') {
        if (claimed.r2Pages === 0) active = await this.#active();
        const page = await this.bucket.list({ limit: STORAGE_INVENTORY_LIMITS.pageSize, include: [], ...(claimed.cursor ? { cursor: claimed.cursor } : {}) });
        assert(page.objects.length <= STORAGE_INVENTORY_LIMITS.pageSize && (!page.truncated || typeof page.cursor === 'string' && page.cursor.length > 0 && page.cursor !== claimed.cursor), 'INVENTORY_INVALID_PAGE', 503, '存储列表暂时无法核验，请重试');
        const seen = new Set<string>();
        for (const object of page.objects) {
          assert(typeof object.key === 'string' && new TextEncoder().encode(object.key).length <= 1024 && !seen.has(object.key), 'INVENTORY_INVALID_PAGE', 503, '存储列表暂时无法核验，请重试'); seen.add(object.key);
          const category = inventoryCategory(object.key), amount = { count: 1, bytes: object.size };
          add(updated.totals[category], amount); add(updated.total, amount);
          if (category === 'releases' || category === 'snapshots') {
            const id = groupId(object.key, category);
            let group = id ? updated.groups.find(row => row.id === id) : undefined;
            if (!group && id && updated.groups.length < MAX_GROUPS) { group = { id, objects: quantity(), snapshots: quantity() }; updated.groups.push(group); }
            if (group) add(category === 'releases' ? group.objects : group.snapshots, amount);
            else { add(updated.unknownReleaseObjects, amount); if (id) updated.groupsTruncated = true; }
          }
        }
        updated.r2Pages++; updated.cursor = page.truncated ? page.cursor : null;
        if (!page.truncated) { updated.objectScanComplete = true; updated.phase = 'release_records'; }
      } else {
        const page = await this.store.list<unknown>('releases', { limit: RELEASE_PAGE_SIZE, ...(claimed.recordsCursor ? { cursor: claimed.recordsCursor } : {}) });
        assert(page.items.length <= RELEASE_PAGE_SIZE && (!page.nextCursor || page.nextCursor !== claimed.recordsCursor), 'INVENTORY_INVALID_PAGE', 503, '发布列表暂时无法核验，请重试');
        for (const row of page.items) { assert(validId(row.id) && !updated.records.some(record => record.id === row.id), 'INVENTORY_INVALID_PAGE', 503, '发布列表暂时无法核验，请重试'); updated.records.push(summarize(row.id, row.data)); }
        updated.releaseRecords += page.items.length; updated.recordsCursor = page.nextCursor;
        if (page.nextCursor === null) { active = await this.#active(); updated.metadataComplete = true; updated.phase = 'done'; updated.status = 'completed'; updated.finishedAt = new Date(this.now()).toISOString(); }
      }
      if (active) { if (active.id && !updated.activeReleaseIds.includes(active.id)) updated.activeReleaseIds.push(active.id); updated.activeObservedAt = active.observedAt; updated.activeObservation = active.status; }
      if (updated.phase !== 'done' && updated.attempts >= STORAGE_INVENTORY_LIMITS.maxAttempts || updated.phase === 'objects' && updated.r2Pages >= STORAGE_INVENTORY_LIMITS.maxR2Pages || updated.phase === 'release_records' && updated.releaseRecords >= STORAGE_INVENTORY_LIMITS.maxReleaseRecords) {
        updated.status = 'limited'; updated.finishedAt = new Date(this.now()).toISOString(); updated.lastError = { code: 'INVENTORY_RUN_LIMIT', message: '本轮盘点已达到上限，结果为部分统计；未知引用仍需人工核查', retryable: false };
      }
      updated.lease = null; updated.updatedAt = new Date(this.now()).toISOString();
      await this.store.transaction(async tx => {
        const state = await tx.get<State>(STORAGE_INVENTORY_KEY), now = this.now();
        if (state?.version === input.expectedVersion && state.job?.id === input.jobId && state.job.lease?.token === token && state.job.lease.expiresAt > now) tx.put(STORAGE_INVENTORY_KEY, { version: state.version + 1, job: { ...updated, updatedAt: new Date(now).toISOString(), ...(updated.finishedAt ? { finishedAt: new Date(now).toISOString() } : {}) } });
      });
    } catch (error) {
      // Persist only a bounded, public-facing diagnostic; upstream errors can contain object keys or credentials.
      const code = error instanceof ApiError && ['INVENTORY_INVALID_PAGE', 'INVENTORY_SIZE_LIMIT', 'INVENTORY_ACTIVE_INVALID'].includes(error.code) ? error.code : 'INVENTORY_READ_FAILED';
      await this.store.transaction(async tx => {
        const state = await tx.get<State>(STORAGE_INVENTORY_KEY), now = this.now();
        if (state?.version === input.expectedVersion && state.job?.id === input.jobId && state.job.lease?.token === token && state.job.lease.expiresAt > now) {
          const exhausted = state.job.attempts >= STORAGE_INVENTORY_LIMITS.maxAttempts;
          tx.put(STORAGE_INVENTORY_KEY, { version: state.version + 1, job: { ...state.job, status: exhausted ? 'limited' : 'failed', lease: null, updatedAt: new Date(now).toISOString(), finishedAt: exhausted ? new Date(now).toISOString() : null,
            lastError: exhausted ? { code: 'INVENTORY_RUN_LIMIT', message: '本轮尝试次数已达到上限，结果为部分统计，可稍后开始新一轮', retryable: false } : { code, message: '本页读取未完成，已保留上次进度，可以重试', retryable: true } } });
        }
      });
    }
    return this.getStatus();
  }
  async #active(): Promise<ActiveObservation> {
    const object = await this.bucket.get('active-release.json'), observedAt = new Date(this.now()).toISOString();
    if (!object) return { id: null, observedAt, status: 'absent' };
    if (object.size >= 4096) { await object.body.cancel(); throw new ApiError('INVENTORY_ACTIVE_INVALID', 503, '公开版本指针无法核验'); }
    const value: unknown = await object.json();
    assert(value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 1 && 'releaseId' in value && validId(value.releaseId), 'INVENTORY_ACTIVE_INVALID', 503, '公开版本指针无法核验');
    return { id: value.releaseId, observedAt, status: 'observed' };
  }
  #version(version: number): void { assert(Number.isSafeInteger(version) && version >= 0, 'INVALID_INVENTORY_VERSION', 422, '盘点版本无效，请刷新'); }
  #input(input: StorageInventoryAdvance): void { this.#version(input.expectedVersion); assert(validId(input.jobId), 'INVALID_INVENTORY_JOB', 422, '盘点任务编号无效'); }
}
