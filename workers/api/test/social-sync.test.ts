import { describe, expect, it, vi } from 'vitest';
import type { BilibiliProfile, GitHubProfile, SocialSyncInput } from '@xvyin/contracts';
import { SocialPublicSync } from '../src/social-sync';
import { MemoryStore } from '../src/store/memory';
import { sanitizeBilibiliProfile } from '../src/bilibili';
import { sanitizeGitHubProfile } from '../src/github-public';
import type { PublicReadCache } from '../src/public-read-cache';

const NOW = Date.UTC(2026, 8, 26, 15), HOUR = 3600_000;
const identity = (run = 1) => ({ runId: `github-${run}`, runAttempt: '1', codeSha: 'a'.repeat(40) });
const bilibili = (now = NOW): BilibiliProfile => sanitizeBilibiliProfile({ code: 0, data: { card: { mid: '520237303', name: '公开作者' }, follower: 42, archive_count: 100, like_num: 1200 } }, now);
const github = (now = NOW): GitHubProfile => sanitizeGitHubProfile({ id: 121843277, login: 'jimmyshuixin', type: 'User', html_url: 'https://github.com/jimmyshuixin', followers: 3, public_repos: 10 }, now);
const work = () => ({ bvid: 'BV17x411w7KC', title: '已验证公开视频', url: 'https://www.bilibili.com/video/BV17x411w7KC/', coverUrl: null, publishedAt: new Date(NOW - HOUR).toISOString(), views: 1, durationSeconds: 20 });
function fixture(cache?: PublicReadCache) {
  let now = NOW; const store = new MemoryStore(), service = new SocialPublicSync(store, () => now, cache);
  const claim = async (run = 1) => (await service.claim(identity(run))).claimId!;
  const input = (claimId: string): SocialSyncInput => ({ claimId, bilibili: { status: 'ok', profile: bilibili(now) }, github: { status: 'ok', profile: github(now) } });
  return { store, service, claim, input, advance: (ms: number) => { now += ms; }, get now() { return now; } };
}

describe('hourly anonymous public social snapshots', () => {
  it('allows exactly one claim per UTC hour across competing workflows, with next boundary rather than a rolling delay', async () => {
    const f = fixture(); f.advance(HOUR - 1000);
    const claims = await Promise.all([1, 2, 3].map(run => f.service.claim(identity(run))));
    expect(claims.filter(claim => claim.accepted)).toHaveLength(1); expect(claims[0]!.nextAllowedAt).toBe(new Date(NOW + HOUR).toISOString());
    f.advance(1000); expect((await f.service.claim(identity(4))).accepted).toBe(true);
    expect((await f.store.list('social_sync')).items).toHaveLength(1);
  });
  it('reuses the current pending claim for transport retry; expiration waits until the next hour', async () => {
    const f = fixture(), first = await f.service.claim(identity());
    expect(await f.service.claim(identity())).toEqual(first);
    f.advance(15 * 60_000);
    expect((await f.service.claim(identity())).accepted).toBe(false); expect((await f.service.claim({ ...identity(), runAttempt: '2' })).accepted).toBe(false);
    await expect(f.service.import(identity(), f.input(first.claimId!))).rejects.toMatchObject({ code: 'SOCIAL_SYNC_CLAIM_EXPIRED' });
  });
  it('makes identical imports idempotent, rejects changed payload/identity and keeps documents bounded', async () => {
    const f = fixture(), id = await f.claim(), input = f.input(id);
    expect(await f.service.import(identity(), input)).toEqual({ imported: true, bilibili: 'updated', github: 'updated' });
    expect(await f.service.import(identity(), input)).toMatchObject({ imported: true });
    input.github = { status: 'failed', reason: 'network' };
    await expect(f.service.import(identity(), input)).rejects.toMatchObject({ code: 'SOCIAL_SYNC_ALREADY_IMPORTED' });
    await expect(f.service.import({ ...identity(), runAttempt: '2' }, input)).rejects.toMatchObject({ code: 'SOCIAL_SYNC_CLAIM_LOST' });
    expect((await f.store.list('social_public')).items).toHaveLength(2);
    f.advance(HOUR); expect((await f.service.claim(identity())).accepted).toBe(false);
  });
  it('fences late old-hour imports after a newer claim begins', async () => {
    const f = fixture(); f.advance(HOUR - 1000); const old = await f.claim();
    f.advance(1000); const current = await f.claim(2);
    await expect(f.service.import(identity(), f.input(old))).rejects.toMatchObject({ code: 'SOCIAL_SYNC_CLAIM_LOST' });
    await f.service.import(identity(2), f.input(current));
    expect((await f.service.publicProfile('bilibili'))?.updatedAt).toBe(new Date(f.now).toISOString());
  });
  it('keeps both data and capture timestamps when one or both upstreams fail', async () => {
    const f = fixture(); await f.service.import(identity(), f.input(await f.claim()));
    const original = await f.service.publicProfile('bilibili'); f.advance(HOUR);
    const update = f.input(await f.claim(2)); update.bilibili = { status: 'failed', reason: 'upstream-blocked' };
    expect(await f.service.import(identity(2), update)).toMatchObject({ bilibili: 'retained', github: 'updated' });
    expect(await f.service.publicProfile('bilibili')).toEqual({ ...original, status: 'stale' });
    expect((await f.service.publicProfile('github'))?.updatedAt).toBe(new Date(f.now).toISOString());
    f.advance(HOUR); const id = await f.claim(3);
    await f.service.import(identity(3), { claimId: id, bilibili: { status: 'failed', reason: 'timeout' }, github: { status: 'failed', reason: 'rate-limited' } });
    expect((await f.service.publicProfile('github'))?.updatedAt).toBe(new Date(NOW + HOUR).toISOString());
    expect((await f.store.get<{ lastError: string }>('social_public/bilibili'))?.lastError).toBe('timeout');
  });
  it('retains an omitted section with its own old date, but clears an explicitly successful empty list', async () => {
    const f = fixture(); const first = f.input(await f.claim());
    if (first.bilibili.status === 'ok') Object.assign(first.bilibili.profile, { works: [work()], worksUpdatedAt: new Date(f.now).toISOString() });
    if (first.github.status === 'ok') Object.assign(first.github.profile, { repositories: [{ name: 'Home2.0', url: 'https://github.com/jimmyshuixin/Home2.0', description: null, language: null, stars: 1, forks: 0, pushedAt: null }], repositoriesUpdatedAt: new Date(f.now).toISOString() });
    await f.service.import(identity(), first); f.advance(HOUR);
    await f.service.import(identity(2), f.input(await f.claim(2)));
    expect(await f.service.publicProfile('bilibili')).toMatchObject({ works: [work()], worksUpdatedAt: new Date(NOW).toISOString(), updatedAt: new Date(f.now).toISOString() });
    expect((await f.service.publicProfile('github'))?.repositoriesUpdatedAt).toBe(new Date(NOW).toISOString());
    f.advance(HOUR); const clear = f.input(await f.claim(3));
    if (clear.bilibili.status === 'ok') Object.assign(clear.bilibili.profile, { works: [], worksUpdatedAt: new Date(f.now).toISOString() });
    if (clear.github.status === 'ok') Object.assign(clear.github.profile, { repositories: [], repositoriesUpdatedAt: new Date(f.now).toISOString() });
    await f.service.import(identity(3), clear);
    expect((await f.service.publicProfile('bilibili'))?.works).toEqual([]); expect((await f.service.publicProfile('github'))?.repositories).toEqual([]);
  });
  it.each(['future', 'before-claim', 'wrong-uid', 'extra-private-field', 'wrong-bvid-url', 'duplicate-work', 'missing-section-date', 'future-section-date', 'wrong-github-id'])('rejects %s data without partially committing another provider', async variant => {
    const f = fixture(); f.advance(1000); const input = f.input(await f.claim()) as unknown as { claimId: string; bilibili: { profile: Record<string, unknown> }; github: { profile: Record<string, unknown> } };
    const profile = input.bilibili.profile;
    if (variant === 'future') profile.updatedAt = new Date(f.now + 1).toISOString();
    if (variant === 'before-claim') profile.updatedAt = new Date(NOW).toISOString();
    if (variant === 'wrong-uid') profile.uid = '1';
    if (variant === 'extra-private-field') profile.cookie = 'never-store-this';
    if (variant === 'wrong-bvid-url') { profile.works = [{ ...work(), url: 'https://www.bilibili.com/video/BV1xx411c7mD/' }]; profile.worksUpdatedAt = profile.updatedAt; }
    if (variant === 'duplicate-work') { profile.works = [work(), work()]; profile.worksUpdatedAt = profile.updatedAt; }
    if (variant === 'missing-section-date') profile.works = [];
    if (variant === 'future-section-date') { profile.works = []; profile.worksUpdatedAt = new Date(f.now + 1).toISOString(); }
    if (variant === 'wrong-github-id') input.github.profile.id = 1;
    await expect(f.service.import(identity(), input)).rejects.toThrow(); expect((await f.store.list('social_public')).items).toEqual([]);
  });
  it('never overwrites a newer stored capture or accepts a future damaged stored snapshot', async () => {
    const f = fixture(), claim = await f.claim();
    await f.store.transaction(async tx => { tx.put('social_public/bilibili', { profile: bilibili(NOW), lastAttemptAt: new Date(NOW).toISOString(), lastError: null }); });
    await expect(f.service.import(identity(), f.input(claim))).rejects.toMatchObject({ code: 'SOCIAL_SYNC_OLD_SNAPSHOT' });
    await f.store.transaction(async tx => { tx.put('social_public/github', { profile: github(NOW + 1), lastAttemptAt: new Date(NOW).toISOString(), lastError: null }); });
    expect(await f.service.publicProfile('github')).toBeNull();
  });
  it('ages stored data without changing capture dates or making network requests', async () => {
    const f = fixture(); await f.service.import(identity(), f.input(await f.claim())); f.advance(25 * HOUR);
    expect(await f.service.publicProfile('github')).toMatchObject({ status: 'snapshot', updatedAt: new Date(NOW).toISOString() });
  });
  it('uses a short sanitized edge cache and recovers from malformed/evicted entries', async () => {
    let cached: Response | undefined;
    const cache = { origin: 'https://xvyin.com', cache: { match: vi.fn(async () => cached?.clone()), put: vi.fn(async (_key, response) => { cached = response.clone(); }) } } as unknown as PublicReadCache;
    const f = fixture(cache); await f.service.import(identity(), f.input(await f.claim()));
    const read = vi.spyOn(f.store, 'get'); await f.service.publicProfile('github'); await f.service.publicProfile('github'); expect(read).toHaveBeenCalledTimes(1);
    cached = Response.json({ profile: github(), checkedAt: NOW + 1000 }); await f.service.publicProfile('github'); expect(read).toHaveBeenCalledTimes(2);
    cached = new Response('x'.repeat(40 * 1024)); await f.service.publicProfile('github'); expect(read).toHaveBeenCalledTimes(3);
    f.advance(60_000); await f.service.publicProfile('github'); expect(read).toHaveBeenCalledTimes(4);
  });
});
