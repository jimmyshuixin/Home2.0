import { describe, expect, it, vi } from 'vitest';
import { DOUYIN_PROFILE_URL, DOUYIN_SEC_UID, type DouyinProfile, type SocialSyncInput } from '@xvyin/contracts';
import { SocialPublicSync } from '../src/social-sync';
import { MemoryStore } from '../src/store/memory';
import { unavailableDouyinProfile } from '../src/douyin-public';
import type { PublicReadCache } from '../src/public-read-cache';

const NOW = Date.UTC(2026, 8, 28, 4), HOUR = 3600_000;
const identity = (run = 1) => ({ runId: `github-${run}`, runAttempt: '1', codeSha: 'a'.repeat(40) });
const stamp = (now: number) => new Date(now).toISOString();
const works: NonNullable<DouyinProfile['works']> = [
  { id: '7661639577056136457', title: '视频作品', kind: 'video', url: 'https://www.douyin.com/video/7661639577056136457', publishedAt: stamp(NOW - HOUR) },
  { id: '7661639577056136458', title: '图文作品', kind: 'note', url: 'https://www.douyin.com/note/7661639577056136458', publishedAt: null },
];
const profile = (now = NOW): DouyinProfile => ({ secUid: DOUYIN_SEC_UID, profileUrl: DOUYIN_PROFILE_URL, name: '公开作者', signature: '生活记录', avatarUrl: null, followers: 10, following: 20, postCount: 30, likes: null, updatedAt: stamp(now), status: 'fresh', authorization: 'public', works: structuredClone(works), worksUpdatedAt: stamp(now) });
function fixture(cache?: PublicReadCache) {
  let now = NOW; const store = new MemoryStore(), service = new SocialPublicSync(store, () => now, cache);
  const claim = async (run = 1) => (await service.claim(identity(run))).claimId!;
  const input = (claimId: string): SocialSyncInput => ({ claimId, bilibili: { status: 'failed', reason: 'network' }, github: { status: 'failed', reason: 'network' }, douyin: { status: 'ok', profile: profile(now) } });
  return { store, service, claim, input, advance: (ms: number) => { now += ms; }, get now() { return now; } };
}

describe('Douyin public snapshot import and read boundary', () => {
  it('has an honest fixed-account unavailable response before the first capture', async () => {
    const f = fixture(); expect(await f.service.publicProfile('douyin')).toBeNull();
    expect(unavailableDouyinProfile()).toEqual({ secUid: DOUYIN_SEC_UID, profileUrl: DOUYIN_PROFILE_URL, name: null, signature: null, avatarUrl: null, followers: null, following: null, postCount: null, likes: null, updatedAt: null, status: 'unavailable', authorization: 'public' });
  });
  it('imports bounded public fields and preserves homepage order, unknown counts and work kinds', async () => {
    const f = fixture(), input = f.input(await f.claim());
    expect(await f.service.import(identity(), input)).toEqual({ imported: true, bilibili: 'retained', github: 'retained', douyin: 'updated' });
    expect(await f.service.publicProfile('douyin')).toEqual(profile());
    expect(await f.service.import(identity(), input)).toMatchObject({ douyin: 'updated' });
    expect((await f.store.list('social_public')).items).toHaveLength(3);
  });
  it('retains last-good profile and works dates through failure and marks old data as a snapshot', async () => {
    const f = fixture(); await f.service.import(identity(), f.input(await f.claim())); f.advance(HOUR);
    const second = f.input(await f.claim(2)); second.douyin = { status: 'failed', reason: 'upstream-blocked' };
    expect(await f.service.import(identity(2), second)).toMatchObject({ douyin: 'retained' });
    expect(await f.service.publicProfile('douyin')).toEqual({ ...profile(), status: 'stale' });
    expect(await f.store.get('social_public/douyin')).toMatchObject({ lastAttemptAt: stamp(f.now), lastError: 'upstream-blocked', profile: { updatedAt: stamp(NOW), worksUpdatedAt: stamp(NOW) } });
    f.advance(24 * HOUR); expect(await f.service.publicProfile('douyin')).toEqual({ ...profile(), status: 'snapshot' });
  });
  it('keeps an omitted works section and its old date, then clears a successful empty capture', async () => {
    const f = fixture(); await f.service.import(identity(), f.input(await f.claim())); f.advance(HOUR);
    const second = f.input(await f.claim(2)); if (second.douyin?.status === 'ok') { delete second.douyin.profile.works; delete second.douyin.profile.worksUpdatedAt; second.douyin.profile.followers = 11; }
    await f.service.import(identity(2), second);
    expect(await f.service.publicProfile('douyin')).toEqual({ ...profile(f.now), followers: 11, worksUpdatedAt: stamp(NOW) });
    f.advance(HOUR); const third = f.input(await f.claim(3)); if (third.douyin?.status === 'ok') third.douyin.profile.works = [];
    await f.service.import(identity(3), third);
    expect(await f.service.publicProfile('douyin')).toMatchObject({ works: [], worksUpdatedAt: stamp(f.now), updatedAt: stamp(f.now) });
  });
  it('old runners leave Douyin data and attempt metadata untouched and replay old control results', async () => {
    const f = fixture(); await f.service.import(identity(), f.input(await f.claim())); const previous = await f.store.get('social_public/douyin'); f.advance(HOUR);
    const old = f.input(await f.claim(2)); delete old.douyin;
    const result = { imported: true, bilibili: 'retained', github: 'retained' };
    expect(await f.service.import(identity(2), old)).toEqual(result);
    expect(await f.service.import(identity(2), old)).toEqual(result);
    expect(await f.store.get('social_public/douyin')).toEqual(previous);
  });
  it.each(['future-profile', 'before-claim-profile', 'future-works', 'before-claim-works', 'future-published', 'duplicate-id', 'wrong-account', 'mismatched-url', 'private-field'])('rejects %s atomically without consuming the import claim', async variant => {
    const f = fixture(); f.advance(1000); const input = f.input(await f.claim());
    const value = (input.douyin as { status: 'ok'; profile: DouyinProfile }).profile as unknown as Record<string, unknown>;
    if (variant === 'future-profile') value.updatedAt = stamp(f.now + 1);
    if (variant === 'before-claim-profile') value.updatedAt = stamp(NOW);
    if (variant === 'future-works') value.worksUpdatedAt = stamp(f.now + 1);
    if (variant === 'before-claim-works') value.worksUpdatedAt = stamp(NOW);
    if (variant === 'future-published') value.works = [{ ...works[0], publishedAt: stamp(f.now + 1) }];
    if (variant === 'duplicate-id') value.works = [works[0], works[0]];
    if (variant === 'wrong-account') value.secUid = 'wrong-account';
    if (variant === 'mismatched-url') value.works = [{ ...works[0], url: works[1]!.url }];
    if (variant === 'private-field') value.cookie = 'private-must-not-be-stored';
    await expect(f.service.import(identity(), input)).rejects.toThrow(); expect((await f.store.list('social_public')).items).toEqual([]);
    expect(await f.store.get('social_sync/control')).toMatchObject({ digest: null, result: null });
    await expect(f.service.import(identity(), f.input(input.claimId))).resolves.toMatchObject({ douyin: 'updated' });
  });
  it('rejects equal or older captures and fences an expired prior run across hour boundaries', async () => {
    const f = fixture(), id = await f.claim(); await f.store.transaction(async tx => { tx.put('social_public/douyin', { profile: profile(), lastAttemptAt: stamp(NOW), lastError: null }); });
    await expect(f.service.import(identity(), f.input(id))).rejects.toMatchObject({ code: 'SOCIAL_SYNC_OLD_SNAPSHOT' });
    f.advance(HOUR); const next = await f.claim(2);
    await expect(f.service.import(identity(), f.input(id))).rejects.toMatchObject({ code: 'SOCIAL_SYNC_CLAIM_LOST' });
    await expect(f.service.import(identity(2), f.input(next))).resolves.toMatchObject({ douyin: 'updated' });
  });
  it('discards corrupted private or future data and never retains it on a failed capture', async () => {
    for (const patch of [{ raw: 'private-response' }, { updatedAt: stamp(NOW + 1) }, { works: [{ ...works[0], publishedAt: stamp(NOW + 1) }] }]) {
      const f = fixture(); await f.store.transaction(async tx => { tx.put('social_public/douyin', { profile: { ...profile(), ...patch }, lastAttemptAt: stamp(NOW), lastError: null }); });
      expect(await f.service.publicProfile('douyin')).toBeNull();
      const input = f.input(await f.claim()); input.douyin = { status: 'failed', reason: 'invalid-response' }; await f.service.import(identity(), input);
      expect(await f.store.get('social_public/douyin')).toMatchObject({ profile: null });
    }
  });
  it('revalidates the short public cache and falls back to the sanitized store', async () => {
    let cached: Response | undefined;
    const cache = { origin: 'https://xvyin.com', cache: { match: vi.fn(async () => cached?.clone()), put: vi.fn(async (_key: Request, response: Response) => { cached = response.clone(); }) } } as unknown as PublicReadCache;
    const f = fixture(cache); await f.service.import(identity(), f.input(await f.claim())); const read = vi.spyOn(f.store, 'get');
    expect(await f.service.publicProfile('douyin')).toEqual(profile()); await f.service.publicProfile('douyin'); expect(read).toHaveBeenCalledTimes(1);
    cached = Response.json({ checkedAt: NOW, profile: { ...profile(), debug: 'private' } });
    expect(await f.service.publicProfile('douyin')).toEqual(profile()); expect(read).toHaveBeenCalledTimes(2);
    cached = new Response('x'.repeat(40 * 1024)); expect(await f.service.publicProfile('douyin')).toEqual(profile()); expect(read).toHaveBeenCalledTimes(3);
  });
});
