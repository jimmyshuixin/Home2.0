import { shanghaiDate, type AnalyticsReport, type EngagementTarget, type LikeState, type TrafficSummary, type VisitInput, type VisitRecord } from '@xvyin/contracts';
import { assert } from './errors';
import { sha256 } from './security';
import type { Snapshot } from './releases';
import type { Store, Transaction } from './store/types';
import { cacheRead, cacheWrite, publicCacheKey, type PublicReadCache } from './public-read-cache';

const DAY = 86_400_000;
export const ENGAGEMENT_LIMITS = { dailyWrites: 3000, visitsPerDay: 300, rawDays: 30, summaryDays: 366, likeStates: 20000, likeTargets: 5000, ipKeys: 1000, analyticsPerIp: 180, likesPerIp: 60 } as const;
const budgetKey = 'engagement_control/daily';
const storageKey = 'engagement_control/storage';
interface Budget { date: string; writes: number; ips: Record<string, { visits: number; likes: number }> }
interface StorageCount { states: number; targets: number }
interface StoredVisit extends VisitRecord { visitor: string; receivedAt: number; lastEventAt: number }
interface RawDay { date: string; expiresAt: number; visits: Record<string, StoredVisit> }
function dayNumber(date: string): number { return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY); }
function rawKey(date: string): string { return `analytics_raw/d${dayNumber(date) % 31}`; }
function rawMetaKey(date: string): string { return `analytics_raw_meta/d${dayNumber(date) % 31}`; }
function summaryKey(date: string): string { return `analytics_days/d${dayNumber(date) % ENGAGEMENT_LIMITS.summaryDays}`; }
function emptySummary(date: string): TrafficSummary { return { date, pageViews: 0, visitors: 0, activeMs: 0, likesAdded: 0, paths: [] }; }
function summaryFor(value: TrafficSummary | null, date: string): TrafficSummary { return value?.date === date ? value : emptySummary(date); }
function budgetFor(value: Budget | null, date: string): Budget { return value?.date === date ? value : { date, writes: 0, ips: {} }; }
function expiresAt(date: string): number { return Date.parse(`${date}T00:00:00+08:00`) + ENGAGEMENT_LIMITS.rawDays * DAY; }

// Best-effort isolate-local abuse protection before database I/O. The finite map
// resets each minute; the durable transaction below separately enforces writes.
const transientGuard = { window: 0, requests: 0, clients: new Map<string, number>() };
export function guardEngagementRequest(request: Request, scope: 'visit' | 'likes', now: number): void {
  const window = Math.floor(now / 60_000);
  if (transientGuard.window !== window) { transientGuard.window = window; transientGuard.requests = 0; transientGuard.clients.clear(); }
  const key = `${scope}:${requestLocation(request).ip || 'unknown'}`, count = transientGuard.clients.get(key) || 0;
  assert(transientGuard.requests < 1200 && count < 60 && (transientGuard.clients.has(key) || transientGuard.clients.size < 1024), 'RATE_LIMITED', 429, '操作过于频繁，请稍后重试');
  transientGuard.requests++; transientGuard.clients.set(key, count + 1);
}

/** Call only after resolving the fresh active release. The cache never contains visitor state. */
export async function cachedLikeCount(context: PublicReadCache | undefined, releaseId: string, target: EngagementTarget, load: () => Promise<{ count: number }>): Promise<{ count: number }> {
  const key = context ? publicCacheKey(context, releaseId, 'index', `like-count/${target.type}/${target.parentId || ''}/${target.id}`) : undefined;
  const cached = key ? await cacheRead(context, key) : undefined;
  if (cached) {
    try {
      const body = await cached.text();
      if (body.length <= 64) { const value = JSON.parse(body) as { count?: unknown }; if (Number.isSafeInteger(value.count) && Number(value.count) >= 0 && Number(value.count) <= ENGAGEMENT_LIMITS.likeStates) return { count: Number(value.count) }; }
    } catch { /* Malformed cache values are replaced with validated public state. */ }
  }
  const result = await load();
  if (context && key) await cacheWrite(context, key, new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' } }));
  return result;
}

/** Resolve only the active public projection. Never read draft/media IDs to establish existence. */
export function publishedTarget(snapshot: Snapshot, target: EngagementTarget): { title: string; path: string } {
  let result: { title: string; path: string } | undefined;
  if (target.type === 'creation') { const value = snapshot.creations.find(item => item.id === target.id); if (value) result = { title: value.title, path: `/creations/${value.slug}/` }; }
  if (target.type === 'album') { const value = snapshot.albums.find(item => item.id === target.id); if (value) result = { title: value.title, path: `/photography/${value.slug}/` }; }
  if (target.type === 'fitness' && snapshot.fitness.settings.enabled) { const value = snapshot.fitness.entries.find(item => item.id === target.id); if (value) result = { title: value.title, path: '/fitness/' }; }
  if (target.type === 'photo') {
    const album = snapshot.albums.find(item => item.id === target.parentId), photo = album?.photos.find(item => item.id === target.id && item.status === 'published');
    if (album && photo) result = { title: `${album.title} · ${photo.caption || photo.alt}`, path: `/photography/${album.slug}/` };
  }
  assert(result, 'NOT_FOUND', 404, '公开内容不存在'); return result;
}
function publicPage(snapshot: Snapshot, path: string): { title: string; path: string } | null {
  const normalized = path === '/' ? '/' : `${path.replace(/\/$/u, '')}/`;
  const pages: Record<string, string> = { '/': '首页', '/about/': '关于', '/creations/': '创作', '/photography/': '摄影', '/fitness/': '健身', '/guestbook/': '留言', '/contact/': '联系', '/privacy/': '隐私说明' };
  if (pages[normalized]) return { path: normalized, title: pages[normalized] };
  const creation = snapshot.creations.find(item => `/creations/${item.slug}/` === normalized);
  if (creation) return { path: normalized, title: creation.title };
  const album = snapshot.albums.find(item => `/photography/${item.slug}/` === normalized);
  return album ? { path: normalized, title: album.title } : null;
}
/** cf is supplied by Cloudflare's request runtime, not by user-provided forwarding headers. */
export function requestLocation(request: Request): Pick<VisitRecord, 'ip' | 'country' | 'region' | 'city'> {
  const cf = (request as Request & { cf?: { country?: unknown; region?: unknown; city?: unknown } }).cf;
  const text = (value: unknown) => typeof value === 'string' && value.length <= 120 ? value : null;
  const header = cf ? request.headers.get('cf-connecting-ip') : null;
  const ip = header && header.length <= 45 && /^[0-9a-f:.]+$/iu.test(header) ? header : null;
  return { ip, country: text(cf?.country), region: text(cf?.region), city: text(cf?.city) };
}
function claimBudget(tx: Transaction, budget: Budget, ip: string, kind: 'visits' | 'likes', writes: number): boolean {
  const current = budget.ips[ip] || { visits: 0, likes: 0 };
  if (budget.writes + writes > ENGAGEMENT_LIMITS.dailyWrites || current[kind] >= (kind === 'visits' ? ENGAGEMENT_LIMITS.analyticsPerIp : ENGAGEMENT_LIMITS.likesPerIp)
    || (!budget.ips[ip] && Object.keys(budget.ips).length >= ENGAGEMENT_LIMITS.ipKeys)) return false;
  budget.writes += writes; budget.ips[ip] = { ...current, [kind]: current[kind] + 1 }; tx.put(budgetKey, budget); return true;
}

export class Engagement {
  constructor(private readonly store: Store, private readonly salt: string, private readonly now: () => number) {}
  private async digest(value: string): Promise<string> { assert(this.salt.length >= 32, 'SERVICE_NOT_CONFIGURED', 503, '访问保护尚未配置'); return sha256(`${this.salt}:engagement:${value}`); }
  async visit(request: Request, input: VisitInput, snapshot: Snapshot): Promise<{ recorded: boolean; reason?: string }> {
    const now = this.now(), date = shanghaiDate(input.startedAt), budgetDate = shanghaiDate(now);
    assert(date <= budgetDate && input.startedAt <= now + 300_000 && input.startedAt >= now - DAY, 'INVALID_VISIT_TIME', 422, '访问记录时间无效');
    const page = publicPage(snapshot, input.path); if (!page) return { recorded: false, reason: 'private_or_unknown_page' };
    const resolved = input.target ? publishedTarget(snapshot, input.target) : page;
    assert(resolved.path === page.path, 'VISIT_TARGET_MISMATCH', 422, '访问内容与页面不符');
    const location = requestLocation(request);
    const [id, visitor, ip] = await Promise.all([this.digest(`visit:${input.visitorId}:${input.visitId}`), this.digest(`visitor:${date}:${input.visitorId}`), this.digest(`ip:${budgetDate}:${location.ip || 'unknown'}`)]);
    return this.store.transaction(async tx => {
      const [raw, storedSummary, storedBudget] = await Promise.all([tx.get<RawDay>(rawKey(date)), tx.get<TrafficSummary>(summaryKey(date)), tx.get<Budget>(budgetKey)]);
      const day: RawDay = raw?.date === date ? raw : { date, expiresAt: expiresAt(date), visits: {} };
      const previous = day.visits[id], summary = summaryFor(storedSummary, date), budget = budgetFor(storedBudget, budgetDate);
      if (!previous && input.type !== 'start') return { recorded: false, reason: 'start_missing' };
      if (previous && (previous.path !== page.path || previous.startedAt !== new Date(input.startedAt).toISOString())) return { recorded: false, reason: 'visit_conflict' };
      if (previous?.ended || (previous && input.type === 'start')) return { recorded: true };
      if (!previous && (now - input.startedAt > 300_000 || Object.keys(day.visits).length >= ENGAGEMENT_LIMITS.visitsPerDay)) return { recorded: false, reason: 'daily_visit_limit' };
      if (previous && input.type === 'heartbeat' && now - previous.lastEventAt < 60_000) return { recorded: true };
      const activeMs = Math.max(previous?.activeMs || 0, Math.min(input.activeMs, Math.max(0, now - (previous?.receivedAt ?? now)) + 2000));
      if (previous && input.type !== 'end' && activeMs === previous.activeMs) return { recorded: true };
      const newDay = raw?.date !== date;
      if (!claimBudget(tx, budget, ip, 'visits', newDay ? 4 : 3)) return { recorded: false, reason: 'free_daily_budget' };
      const delta = activeMs - (previous?.activeMs || 0);
      if (!previous) { summary.pageViews++; if (!Object.values(day.visits).some(item => item.visitor === visitor)) summary.visitors++; }
      summary.activeMs += delta;
      let pathSummary = summary.paths.find(item => item.path === page.path);
      if (!pathSummary && summary.paths.length < 40) { pathSummary = { ...page, views: 0, activeMs: 0 }; summary.paths.push(pathSummary); }
      if (pathSummary) { pathSummary.views += previous ? 0 : 1; pathSummary.activeMs += delta; }
      day.visits[id] = previous ? { ...previous, activeMs, ended: input.type === 'end', updatedAt: new Date(now).toISOString(), lastEventAt: now } : {
        id, visitor, path: page.path, title: resolved.title.slice(0, 240), target: input.target || null,
        startedAt: new Date(input.startedAt).toISOString(), receivedAt: now, lastEventAt: now, updatedAt: new Date(now).toISOString(), activeMs, ended: input.type === 'end', ...location,
      };
      tx.put(rawKey(date), day); tx.put(summaryKey(date), summary);
      if (newDay) tx.put(rawMetaKey(date), { date, expiresAt: day.expiresAt });
      return { recorded: true };
    });
  }
  private async likeKeys(target: EngagementTarget, visitorId: string): Promise<{ state: string; counter: string }> {
    const targetHash = await this.digest(`target:${target.type}:${target.parentId || ''}:${target.id}`);
    return { counter: `like_counts/${targetHash}`, state: `like_states/${await this.digest(`like:${targetHash}:${visitorId}`)}` };
  }
  async likes(target: EngagementTarget, visitorId: string, snapshot: Snapshot): Promise<LikeState> {
    publishedTarget(snapshot, target); const keys = await this.likeKeys(target, visitorId);
    const [counter, state] = await this.store.getMany<{ count?: number; liked?: boolean }>([keys.counter, keys.state]);
    return { count: counter?.count || 0, liked: state?.liked === true };
  }
  async count(target: EngagementTarget, snapshot: Snapshot): Promise<{ count: number }> {
    publishedTarget(snapshot, target);
    const hash = await this.digest(`target:${target.type}:${target.parentId || ''}:${target.id}`);
    const counter = await this.store.get<{ count: number }>(`like_counts/${hash}`); return { count: counter?.count || 0 };
  }
  async setLike(request: Request, target: EngagementTarget, visitorId: string, liked: boolean, snapshot: Snapshot): Promise<LikeState> {
    publishedTarget(snapshot, target); const keys = await this.likeKeys(target, visitorId), date = shanghaiDate(this.now());
    const ip = await this.digest(`ip:${date}:${requestLocation(request).ip || 'unknown'}`);
    return this.store.transaction(async tx => {
      const [counter, state] = await Promise.all([tx.get<{ count: number }>(keys.counter), tx.get<{ liked: true }>(keys.state)]);
      const before = counter?.count || 0;
      if (Boolean(state) === liked) return { count: before, liked };
      const [storedBudget, storedStorage, storedSummary] = await Promise.all([tx.get<Budget>(budgetKey), tx.get<StorageCount>(storageKey), tx.get<TrafficSummary>(summaryKey(date))]);
      const storage = storedStorage || { states: 0, targets: 0 }, summary = summaryFor(storedSummary, date);
      const count = Math.max(0, before + (liked ? 1 : -1));
      assert(!liked || (storage.states < ENGAGEMENT_LIMITS.likeStates && (counter || storage.targets < ENGAGEMENT_LIMITS.likeTargets)), 'FREE_STORAGE_LIMIT', 429, '免费点赞存储已达保护上限');
      assert(claimBudget(tx, budgetFor(storedBudget, date), ip, 'likes', liked ? 5 : 4), 'FREE_DAILY_BUDGET', 429, '今日免费互动额度已用完，请明天再来');
      if (liked) { tx.put(keys.state, { liked: true }); summary.likesAdded++; tx.put(summaryKey(date), summary); } else tx.delete(keys.state);
      if (count) tx.put(keys.counter, { count }); else tx.delete(keys.counter);
      tx.put(storageKey, { states: Math.max(0, storage.states + (liked ? 1 : -1)), targets: Math.max(0, storage.targets + (!counter && count ? 1 : counter && !count ? -1 : 0)) });
      return { count, liked };
    });
  }
  /** Actual deletion, independent of page views. Called by a configured daily cron and admin reads. */
  async cleanup(): Promise<number> {
    const now = this.now();
    const keys = Array.from({ length: 31 }, (_, index) => `analytics_raw_meta/d${index}`);
    const candidates = await this.store.getMany<{ date: string; expiresAt: number }>(keys);
    const expired = keys.filter((_, index) => candidates[index] && candidates[index]!.expiresAt <= now);
    if (!expired.length) return 0;
    return this.store.transaction(async tx => {
      // Re-read only expired candidates inside the serializable transaction so a
      // concurrently overwritten day slot cannot be deleted using stale metadata.
      const rows = await Promise.all(expired.map(key => tx.get<{ date: string; expiresAt: number }>(key)));
      let deleted = 0; rows.forEach((row, index) => { if (row && row.expiresAt <= now) { tx.delete(expired[index]!.replace('analytics_raw_meta/', 'analytics_raw/')); tx.delete(expired[index]!); deleted++; } }); return deleted;
    });
  }
  async report(date: string, cursor?: string): Promise<{ report: AnalyticsReport; nextCursor: string | null }> {
    const today = shanghaiDate(this.now()); assert(dayNumber(date) <= dayNumber(today) && dayNumber(date) > dayNumber(today) - ENGAGEMENT_LIMITS.summaryDays, 'INVALID_DATE_RANGE', 422, '可查看最近一年的统计');
    await this.cleanup();
    const historyDates = Array.from({ length: 7 }, (_, index) => new Date((dayNumber(date) - 6 + index) * DAY).toISOString().slice(0, 10));
    const [raw, budget, ...summaries] = await this.store.getMany<RawDay | Budget | TrafficSummary>([rawKey(date), budgetKey, ...historyDates.map(summaryKey)]);
    const rawDay = raw as RawDay | null, currentBudget = budgetFor(budget as Budget | null, today);
    const history = historyDates.map((day, index) => summaryFor(summaries[index] as TrafficSummary | null, day));
    const detailAvailable = Boolean(rawDay?.date === date && rawDay.expiresAt > this.now());
    let after = '';
    if (cursor) { assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_[0-9a-f]{64}$/u.test(cursor), 'INVALID_CURSOR', 422, '分页位置无效'); after = cursor; }
    const sortKey = (row: VisitRecord) => `${row.startedAt}_${row.id}`;
    const all = detailAvailable ? Object.values(rawDay!.visits).sort((a, b) => sortKey(b).localeCompare(sortKey(a))).filter(row => !after || sortKey(row) < after) : [];
    const visits = all.slice(0, 25).map(({ visitor: _visitor, receivedAt: _receivedAt, lastEventAt: _lastEventAt, ...record }) => record);
    return { report: { summary: history.at(-1)!, visits, history, limits: { retentionDays: ENGAGEMENT_LIMITS.rawDays, dailyWriteLimit: ENGAGEMENT_LIMITS.dailyWrites, writesUsed: currentBudget.writes, maxVisitsPerDay: ENGAGEMENT_LIMITS.visitsPerDay, detailAvailable, limited: currentBudget.writes >= ENGAGEMENT_LIMITS.dailyWrites || history.at(-1)!.pageViews >= ENGAGEMENT_LIMITS.visitsPerDay } }, nextCursor: all.length > 25 ? sortKey(visits.at(-1)!) : null };
  }
}
