import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AlbumDraftSchema, CreationDraftSchema, shanghaiDate, type EngagementTarget, type VisitInput } from '@xvyin/contracts';
import { cachedLikeCount, Engagement, ENGAGEMENT_LIMITS, guardEngagementRequest, publishedTarget, requestLocation } from '../src/engagement';
import { emptySnapshot, type Snapshot } from '../src/releases';
import { MemoryStore } from '../src/store/memory';
import { createApi } from '../src/app';
import type { AuthProvider } from '../src/auth';
import type { PublicReadCache } from '../src/public-read-cache';

const origin = 'https://site.invalid';
const salt = 'test-only-privacy-salt-012345678901234567890';
let now = Date.parse('2026-09-19T04:00:00Z');
let store: MemoryStore, engagement: Engagement, snapshot: Snapshot;
const target: EngagementTarget = { type: 'creation', id: 'public-creation' };
const visitor = 'c4b3c9b0-a723-4c5d-b1af-3179ae4b4e54';
function request(ip = '203.0.113.5') {
  const result = new Request(origin, { headers: { 'cf-connecting-ip': ip, 'x-forwarded-for': '192.0.2.99' } });
  Object.defineProperty(result, 'cf', { value: { country: 'CN', region: 'Shanghai', city: 'Shanghai' } }); return result;
}
function visit(values: Partial<VisitInput> = {}): VisitInput { return { visitorId: visitor, visitId: crypto.randomUUID(), type: 'start', startedAt: now, activeMs: 0, path: '/creations/public/', target, ...values }; }
beforeEach(() => {
  now = Date.parse('2026-09-19T04:00:00Z'); store = new MemoryStore(); engagement = new Engagement(store, salt, () => now); snapshot = emptySnapshot('published');
  snapshot.creations = [{ ...CreationDraftSchema.parse({ title: 'Public work', slug: 'public' }), id: target.id, revisionId: 'rev-public', publishedAt: new Date(now).toISOString(), formats: [] }];
  snapshot.albums = [{ ...AlbumDraftSchema.parse({ title: 'Album', slug: 'album', photos: [{ id: 'photo-public', assetId: 'asset-public', alt: 'Photo', status: 'published' }, { id: 'photo-hidden', assetId: 'asset-private', alt: 'Private', status: 'hidden' }] }), id: 'album-public', revisionId: 'rev-album', publishedAt: new Date(now).toISOString() }];
});

describe('visitor privacy and published boundaries', () => {
  it('only trusts the Cloudflare request metadata, never client forwarding headers', () => {
    const local = new Request(origin, { headers: { 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '192.0.2.2' } });
    expect(requestLocation(local)).toEqual({ ip: null, country: null, region: null, city: null });
    expect(requestLocation(request())).toEqual({ ip: '203.0.113.5', country: 'CN', region: 'Shanghai', city: 'Shanghai' });
  });
  it('requires an active public content/photo projection for engagement', async () => {
    expect(publishedTarget(snapshot, { type: 'photo', id: 'photo-public', parentId: 'album-public' }).title).toContain('Photo');
    for (const value of [{ type: 'creation', id: 'draft-only' }, { type: 'photo', id: 'photo-hidden', parentId: 'album-public' }, { type: 'photo', id: 'photo-public', parentId: 'private-album' }] as EngagementTarget[]) {
      await expect(engagement.likes(value, visitor, snapshot)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      await expect(engagement.setLike(request(), value, visitor, true, snapshot)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect((await store.list('like_states')).items).toHaveLength(0);
  });
  it('rejects private paths and mismatched targets without storing private metadata', async () => {
    expect(await engagement.visit(request(), visit({ path: '/admin/' }), snapshot)).toEqual({ recorded: false, reason: 'private_or_unknown_page' });
    await expect(engagement.visit(request(), visit({ path: '/' }), snapshot)).rejects.toMatchObject({ code: 'VISIT_TARGET_MISMATCH' });
    expect((await store.list('analytics_raw')).items).toHaveLength(0);
  });
});

describe('visits, active duration and retention', () => {
  it('deduplicates starts/end retries, keeps duration monotonic and counts a visitor once per day', async () => {
    const first = visit(); await engagement.visit(request(), first, snapshot); await engagement.visit(request(), first, snapshot);
    expect(await store.get('engagement_control/daily')).toMatchObject({ writes: 4 });
    now += 70_000; await engagement.visit(request(), { ...first, type: 'heartbeat', activeMs: 65_000 }, snapshot);
    now += 70_000; await engagement.visit(request(), { ...first, type: 'heartbeat', activeMs: 20_000 }, snapshot);
    now += 20_000; await engagement.visit(request(), { ...first, type: 'end', activeMs: 80_000 }, snapshot);
    await engagement.visit(request(), { ...first, type: 'end', activeMs: 500_000 }, snapshot);
    await engagement.visit(request(), { ...first, type: 'heartbeat', activeMs: 500_000 }, snapshot);
    await engagement.visit(request(), visit(), snapshot);
    const { report } = await engagement.report('2026-09-19');
    expect(report.summary).toMatchObject({ pageViews: 2, visitors: 1, activeMs: 80_000 });
    expect(report.visits.find(row => row.ended)).toMatchObject({ activeMs: 80_000, ip: '203.0.113.5', title: 'Public work' });
    expect(report.visits[0]).not.toHaveProperty('visitor');
    expect(await store.get('engagement_control/daily')).toMatchObject({ writes: 13 });
  });
  it('caps forged duration and ignores heartbeat traffic more frequent than once a minute', async () => {
    const first = visit(); await engagement.visit(request(), first, snapshot);
    now += 5000; await engagement.visit(request(), { ...first, type: 'heartbeat', activeMs: 1000000 }, snapshot);
    expect(await store.get('engagement_control/daily')).toMatchObject({ writes: 4 });
    now += 60000; await engagement.visit(request(), { ...first, type: 'end', activeMs: 1000000 }, snapshot);
    expect((await engagement.report('2026-09-19')).report.summary.activeMs).toBe(67000);
  });
  it('keeps the original day when an open page crosses midnight', async () => {
    now = Date.parse('2026-09-19T15:59:30Z'); const first = visit(); await engagement.visit(request(), first, snapshot);
    now += 90_000; await engagement.visit(request(), { ...first, type: 'end', activeMs: 80_000 }, snapshot);
    expect(shanghaiDate(now)).toBe('2026-09-20');
    expect((await engagement.report('2026-09-19')).report.summary).toMatchObject({ pageViews: 1, activeMs: 80_000 });
    expect((await engagement.report('2026-09-20')).report.summary.pageViews).toBe(0);
  });
  it('really deletes raw IP documents at expiry, while retaining anonymous day summaries', async () => {
    await engagement.visit(request(), visit(), snapshot);
    expect(JSON.stringify((await store.list('analytics_raw')).items)).toContain('203.0.113.5');
    now = Date.parse('2026-10-18T16:00:00Z');
    expect(await engagement.cleanup()).toBe(1);
    expect((await store.list('analytics_raw')).items).toHaveLength(0);
    expect((await store.list('analytics_raw_meta')).items).toHaveLength(0);
    const report = (await engagement.report('2026-09-19')).report;
    expect(report.summary.pageViews).toBe(1); expect(report.visits).toEqual([]); expect(report.limits.detailAvailable).toBe(false);
    expect(JSON.stringify((await store.list('analytics_days')).items)).not.toContain('203.0.113.5');
  });
  it('paginates newest visits deterministically without rescanning other days', async () => {
    for (let index = 0; index < 28; index++) { await engagement.visit(request(), visit(), snapshot); now += 1000; }
    const first = await engagement.report('2026-09-19');
    expect(first.report.visits).toHaveLength(25); expect(first.nextCursor).toBeTruthy();
    const second = await engagement.report('2026-09-19', first.nextCursor!);
    expect(second.report.visits).toHaveLength(3); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.report.visits, ...second.report.visits].map(row => row.id)).size).toBe(28);
    expect(first.report.visits[0]!.startedAt > second.report.visits[0]!.startedAt).toBe(true);
    await expect(engagement.report('2026-09-19', 'malformed')).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
});

describe('free quota and anonymous likes', () => {
  it('atomically counts one like per visitor/target and makes repeated desired state idempotent', async () => {
    const replies = await Promise.all(Array.from({ length: 5 }, () => engagement.setLike(request(), target, visitor, true, snapshot)));
    expect(replies).toEqual(Array(5).fill({ count: 1, liked: true }));
    expect(await engagement.likes(target, visitor, snapshot)).toEqual({ count: 1, liked: true });
    expect(await engagement.likes(target, crypto.randomUUID(), snapshot)).toEqual({ count: 1, liked: false });
    expect(await store.get('engagement_control/daily')).toMatchObject({ writes: 5 });
    await engagement.setLike(request(), target, visitor, false, snapshot); await engagement.setLike(request(), target, visitor, false, snapshot);
    expect(await store.get('engagement_control/daily')).toMatchObject({ writes: 9 });
    expect(await store.get('engagement_control/storage')).toEqual({ states: 0, targets: 0 });
    expect((await store.list('like_states')).items).toHaveLength(0); expect((await store.list('like_counts')).items).toHaveLength(0);
  });
  it('counts actual document writes and refuses both analytics and likes before exceeding the daily budget', async () => {
    await store.transaction(async tx => tx.put('engagement_control/daily', { date: '2026-09-19', writes: ENGAGEMENT_LIMITS.dailyWrites - 4, ips: {} }));
    await expect(engagement.setLike(request(), target, visitor, true, snapshot)).rejects.toMatchObject({ code: 'FREE_DAILY_BUDGET' });
    expect(await engagement.visit(request(), visit(), snapshot)).toEqual({ recorded: true });
    expect(await engagement.visit(request(), visit(), snapshot)).toEqual({ recorded: false, reason: 'free_daily_budget' });
    expect(await store.get('engagement_control/daily')).toMatchObject({ writes: ENGAGEMENT_LIMITS.dailyWrites });
    now += 86400_000; expect(await engagement.setLike(request(), target, visitor, true, snapshot)).toEqual({ count: 1, liked: true });
    expect(await store.get('engagement_control/daily')).toMatchObject({ date: '2026-09-20', writes: 5 });
  });
  it('places a hard lifetime bound on persistent anonymous like states', async () => {
    await store.transaction(async tx => tx.put('engagement_control/storage', { states: ENGAGEMENT_LIMITS.likeStates, targets: 100 }));
    await expect(engagement.setLike(request(), target, visitor, true, snapshot)).rejects.toMatchObject({ code: 'FREE_STORAGE_LIMIT' });
    expect(await store.get('engagement_control/daily')).toBeNull();
  });
  it('bounds per-IP changes even when a client rotates its visitor UUID', async () => {
    for (let index = 0; index < ENGAGEMENT_LIMITS.likesPerIp; index++) await engagement.setLike(request(), target, crypto.randomUUID(), true, snapshot);
    await expect(engagement.setLike(request(), target, crypto.randomUUID(), true, snapshot)).rejects.toMatchObject({ code: 'FREE_DAILY_BUDGET' });
    expect((await store.list('engagement_control')).items).toHaveLength(2);
  });
});

describe('HTTP privacy and authentication boundaries', () => {
  function api() { return createApi({ store, bucket: {} as R2Bucket, auth: {} as AuthProvider, now: () => now, privacySalt: salt, secureCookies: true, allowedOrigins: [origin], adminUsername: 'test', codeSha: 'a'.repeat(40) }); }
  it('requires admin authentication before exposing raw visitor records', async () => {
    const response = await api().app.request(`${origin}/api/v1/admin/analytics`); expect(response.status).toBe(401);
  });
  it('honors DNT and preview/admin exclusion before any store reads or writes', async () => {
    const privacyHeaders: Array<Record<string, string>> = [{ dnt: '1' }, { 'sec-gpc': '1' }, { cookie: '__Host-xvyin_preview=test' }, { cookie: '__Host-xvyin_session=test' }];
    for (const headers of privacyHeaders) {
      const response = await api().app.request(`${origin}/api/v1/analytics/visit`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(visit()) });
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ data: { recorded: false, reason: 'privacy_or_admin' } });
    }
    expect((await store.list('analytics_raw')).items).toHaveLength(0);
  });
});

describe('free read protection and small cleanup metadata', () => {
  it('caches only a public count for 60 seconds and isolates each active release', async () => {
    const cache = new Map<string, Response>();
    const context: PublicReadCache = { origin, cache: { match: (async (key: Request) => cache.get(key.url)?.clone()) as Cache['match'], put: (async (key: Request, value: Response) => { cache.set(key.url, value.clone()); }) as Cache['put'] } };
    const load = vi.fn(async () => ({ count: 4 }));
    expect(await cachedLikeCount(context, 'published', target, load)).toEqual({ count: 4 });
    expect(await cachedLikeCount(context, 'published', target, load)).toEqual({ count: 4 });
    expect(load).toHaveBeenCalledTimes(1);
    expect([...cache.values()][0]!.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await [...cache.values()][0]!.clone().json()).toEqual({ count: 4 });
    await cachedLikeCount(context, 'new-release', target, load); expect(load).toHaveBeenCalledTimes(2);
  });
  it('needs one document read for an anonymous count and never reads visitor states', async () => {
    await engagement.setLike(request(), target, visitor, true, snapshot);
    const get = vi.spyOn(store, 'get'), many = vi.spyOn(store, 'getMany');
    expect(await engagement.count(target, snapshot)).toEqual({ count: 1 });
    expect(get).toHaveBeenCalledTimes(1); expect(get.mock.calls[0]![0]).toMatch(/^like_counts\//u); expect(many).not.toHaveBeenCalled();
  });
  it('blocks hot repeats before database I/O and expires transient quotas', () => {
    const instant = now + 7 * 86400000;
    for (let index = 0; index < 60; index++) guardEngagementRequest(request('203.0.113.77'), 'likes', instant);
    expect(() => guardEngagementRequest(request('203.0.113.77'), 'likes', instant)).toThrow();
    expect(() => guardEngagementRequest(request('203.0.113.77'), 'likes', instant + 60000)).not.toThrow();
  });
  it('cleanup reads only tiny expiry records, without deserializing raw visit payloads', async () => {
    await engagement.visit(request(), visit(), snapshot);
    const original = store.transaction.bind(store), reads: string[] = [], many = vi.spyOn(store, 'getMany');
    vi.spyOn(store, 'transaction').mockImplementation(callback => original(tx => callback({ get: async key => { reads.push(key); return tx.get(key); }, put: tx.put.bind(tx), delete: tx.delete.bind(tx) })));
    await engagement.cleanup();
    expect(many).toHaveBeenCalledTimes(1); expect(many.mock.calls[0]![0]).toHaveLength(31);
    expect(many.mock.calls[0]![0].every(key => key.startsWith('analytics_raw_meta/'))).toBe(true); expect(reads).toEqual([]);
    now += 31 * 86400000; await engagement.cleanup();
    expect(reads).toHaveLength(1); expect(reads.every(key => key.startsWith('analytics_raw_meta/'))).toBe(true);
  });
  it('rejects a future calendar day even within clock-skew tolerance, preserving the retention bound', async () => {
    now = Date.parse('2026-09-19T15:59:30Z');
    await expect(engagement.visit(request(), visit({ startedAt: now + 60000 }), snapshot)).rejects.toMatchObject({ code: 'INVALID_VISIT_TIME' });
  });
});
