import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BILIBILI_PROFILE_URL, BILIBILI_UID, BilibiliProfileSchema } from '@xvyin/contracts';
import { readBilibiliProfile as readProfile, type BilibiliFetch } from '../src/bilibili';
import packagedSnapshot from '../src/bilibili-profile-snapshot.json';
import { createApi, type Runtime } from '../src/app';
import type { PublicReadCache } from '../src/public-read-cache';
import { MemoryStore } from '../src/store/memory';

const instant = Date.UTC(2026, 8, 26, 8);
const HOUR = 60 * 60_000;
const readBilibiliProfile = (options: Parameters<typeof readProfile>[0]) => readProfile({ fallbackSnapshot: null, ...options });
const example = () => ({
  code: 0,
  data: {
    card: { mid: BILIBILI_UID, name: '测试 UP', sign: '公开简介', face: 'http://i2.hdslb.com/bfs/face/avatar.jpg', sex: 'private-fixture', following: 33 },
    follower: 2546, archive_count: 451, like_num: 46370, following: true,
  },
});
const successfulFetch = () => vi.fn<BilibiliFetch>(async () => Response.json(example()));
function edgeCache() {
  let saved: Response | undefined;
  const context: PublicReadCache = { origin: 'https://xvyin.invalid', cache: {
    match: vi.fn(async () => saved?.clone()),
    put: vi.fn(async (_key: Parameters<Cache['put']>[0], response: Response) => { saved = response.clone(); }),
  } };
  return { context, get saved() { return saved; }, set saved(value: Response | undefined) { saved = value; } };
}
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('fixed public Bilibili profile', () => {
  it('returns only sanitized public fields from the fixed UID without forwarding visitor information', async () => {
    const value = example();
    value.data.card.name = ' <b>测试 UP</b>\u0000 ';
    value.data.card.sign = '<script>inert text</script>\u202e' + '文'.repeat(600);
    const fetcher = vi.fn<BilibiliFetch>(async () => Response.json(value));
    const profile = await readBilibiliProfile({ now: () => instant, fetcher });
    expect(profile).toEqual({
      uid: BILIBILI_UID, profileUrl: BILIBILI_PROFILE_URL, name: '测试 UP', signature: ('inert text ' + '文'.repeat(600)).slice(0, 500),
      avatarUrl: 'https://i2.hdslb.com/bfs/face/avatar.jpg', followers: 2546, videoCount: 451, likes: 46370,
      updatedAt: new Date(instant).toISOString(), status: 'fresh', authorization: 'public',
    });
    expect(BilibiliProfileSchema.safeParse(profile).success).toBe(true);
    const request = fetcher.mock.calls[0]![0];
    expect(request.url).toBe('https://api.bilibili.com/x/web-interface/card?mid=520237303');
    expect(request.method).toBe('GET'); expect(request.redirect).toBe('manual');
    expect([...request.headers.entries()]).toEqual([['accept', 'application/json']]);
  });

  it('leaves missing, negative, fractional and string statistics null while preserving genuine zero', async () => {
    const value = example();
    const fetcher: BilibiliFetch = async () => Response.json({ ...value, data: { card: { ...value.data.card, sign: null }, follower: -1, archive_count: '451', like_num: 0 } });
    expect(await readBilibiliProfile({ now: () => instant, fetcher })).toMatchObject({ followers: null, videoCount: null, likes: 0, signature: null, status: 'fresh' });
    expect(await readBilibiliProfile({ now: () => instant, fetcher: async () => Response.json({ ...value, data: { card: value.data.card, follower: 1.5, archive_count: Number.MAX_SAFE_INTEGER + 1 } }) })).toMatchObject({ followers: null, videoCount: null, likes: null });
  });

  it.each([
    'https://i2.hdslb.com.attacker.invalid/bfs/face/avatar.jpg',
    'https://attacker.invalid/bfs/face/avatar.jpg',
    'https://secret@i2.hdslb.com/bfs/face/avatar.jpg',
    'https://i2.hdslb.com:8443/bfs/face/avatar.jpg',
    'https://i2.hdslb.com/bfs/face/avatar.svg',
    'https://i2.hdslb.com/bfs/face/avatar.jpg?private=token',
    'https://i2.hdslb.com/bfs/face/avatar.jpg#fragment',
    '//i2.hdslb.com/bfs/face/avatar.jpg',
    'javascript:alert(1)',
  ])('drops an unapproved avatar URL: %s', async face => {
    const value = example(); value.data.card.face = face;
    const result = await readBilibiliProfile({ now: () => instant, fetcher: async () => Response.json(value) });
    expect(result.status).toBe('fresh'); expect(result.avatarUrl).toBeNull();
  });

  it.each([
    ['wrong UID', () => Response.json({ code: 0, data: { ...example().data, card: { ...example().data.card, mid: '1' } } })],
    ['missing name', () => Response.json({ code: 0, data: { card: { mid: BILIBILI_UID } } })],
    ['risk control', () => Response.json({ code: -352, message: 'blocked', data: null })],
    ['forbidden', () => new Response('blocked', { status: 403 })],
    ['redirect', () => new Response('', { status: 302, headers: { location: 'https://attacker.invalid/' } })],
    ['invalid JSON', () => new Response('{broken')],
    ['HTML challenge', () => new Response('<html>challenge</html>')],
    ['invalid UTF-8', () => new Response(new Uint8Array([0xc3, 0x28]))],
    ['oversized declared body', () => new Response('{}', { headers: { 'content-length': '65537' } })],
    ['oversized streamed body', () => new Response('x'.repeat(65537))],
  ] satisfies Array<[string, () => Response]>)('degrades to explicit unavailable for %s', async (_label, response) => {
    const result = await readBilibiliProfile({ now: () => instant, fetcher: async () => response() });
    expect(result).toEqual({ uid: BILIBILI_UID, profileUrl: BILIBILI_PROFILE_URL, name: null, signature: null, avatarUrl: null, followers: null, videoCount: null, likes: null, updatedAt: null, status: 'unavailable', authorization: 'public' });
  });

  it('limits fetch and stalled-body latency to five seconds and aborts the upstream request', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<BilibiliFetch>(() => new Promise(() => {}));
    const result = readBilibiliProfile({ now: () => instant, fetcher });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await result).status).toBe('unavailable');
    expect(fetcher.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(console.warn).toHaveBeenLastCalledWith(JSON.stringify({ level: 'warn', code: 'BILIBILI_PUBLIC_PROFILE_UNAVAILABLE', reason: 'timeout' }));

    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const stalled = readBilibiliProfile({ now: () => instant, fetcher: async () => new Response(body) });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await stalled).status).toBe('unavailable'); expect(cancelled).toBe(true);
  });

  it('serves fresh cache for one hour, retains stale data on failure and backs off for five minutes', async () => {
    const cache = edgeCache(), fetcher = successfulFetch();
    let clock = instant;
    const read = () => readBilibiliProfile({ now: () => clock, cache: cache.context, fetcher });
    const first = await read();
    expect(cache.saved?.headers.get('cache-control')).toBe('public, max-age=86400');
    clock += HOUR - 1;
    expect(await read()).toEqual(first); expect(fetcher).toHaveBeenCalledTimes(1);
    clock += 1;
    fetcher.mockImplementation(async () => { throw new Error('upstream outage'); });
    expect(await read()).toEqual({ ...first, status: 'stale' }); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.saved?.headers.get('cache-control')).toBe('public, max-age=82800');
    clock += 5 * 60_000 - 1;
    expect(await read()).toEqual({ ...first, status: 'stale' }); expect(fetcher).toHaveBeenCalledTimes(2);
    clock += 1;
    fetcher.mockImplementation(async () => Response.json(example()));
    expect(await read()).toMatchObject({ status: 'fresh', updatedAt: new Date(clock).toISOString() });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('backs off cold-cache failures and never extends retained profile age beyond 24 hours', async () => {
    const cache = edgeCache(), fetcher = successfulFetch();
    let clock = instant;
    const read = () => readBilibiliProfile({ now: () => clock, cache: cache.context, fetcher });
    await read();
    fetcher.mockImplementation(async () => { throw new Error('upstream outage'); });
    clock += 24 * HOUR - 1000;
    expect((await read()).status).toBe('stale');
    expect(cache.saved?.headers.get('cache-control')).toBe('public, max-age=1');
    clock += 1000;
    expect((await read()).status).toBe('unavailable');
    expect(cache.saved?.headers.get('cache-control')).toBe('public, max-age=300');
    expect(fetcher).toHaveBeenCalledTimes(3);
    clock += 5 * 60_000 - 1;
    expect((await read()).status).toBe('unavailable'); expect(fetcher).toHaveBeenCalledTimes(3);
    clock += 1;
    expect((await read()).status).toBe('unavailable'); expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('survives cache eviction, invalid JSON and cache I/O failure without database fallback', async () => {
    const cache = edgeCache(), fetcher = successfulFetch();
    const read = () => readBilibiliProfile({ now: () => instant, cache: cache.context, fetcher });
    await read(); cache.saved = undefined;
    expect((await read()).status).toBe('fresh'); expect(fetcher).toHaveBeenCalledTimes(2);
    cache.saved = new Response('{broken');
    expect((await read()).status).toBe('fresh');
    vi.mocked(cache.context.cache.match).mockRejectedValue(new Error('cache unavailable'));
    vi.mocked(cache.context.cache.put).mockRejectedValue(new Error('cache unavailable'));
    expect((await read()).status).toBe('fresh'); expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each(['future check', 'future profile', 'invalid date', 'expired profile', 'stale status', 'extra private field', 'invalid avatar'])('rejects corrupt cache state: %s', async issue => {
    const cache = edgeCache(), fetcher = successfulFetch();
    const profile = await readBilibiliProfile({ now: () => instant, fetcher });
    const state = { profile: { ...profile }, checkedAt: instant };
    if (issue === 'future check') state.checkedAt = instant + 1;
    if (issue === 'future profile') state.profile.updatedAt = new Date(instant + 1).toISOString();
    if (issue === 'invalid date') state.profile.updatedAt = 'not a date';
    if (issue === 'expired profile') state.profile.updatedAt = new Date(instant - 24 * HOUR).toISOString();
    if (issue === 'stale status') state.profile.status = 'stale';
    if (issue === 'extra private field') Object.assign(state.profile, { cookie: 'private-fixture' });
    if (issue === 'invalid avatar') state.profile.avatarUrl = 'https://attacker.invalid/avatar.jpg';
    cache.saved = Response.json(state);
    expect(await readBilibiliProfile({ now: () => instant, cache: cache.context, fetcher })).toEqual(profile);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses waitUntil for the optional cache write without returning a mutable cached reference', async () => {
    const cache = edgeCache(), fetcher = successfulFetch(), tasks: Promise<unknown>[] = [];
    const context = { ...cache.context, waitUntil: (task: Promise<unknown>) => { tasks.push(task); } };
    const first = await readBilibiliProfile({ now: () => instant, cache: context, fetcher });
    await Promise.all(tasks); expect(tasks).toHaveLength(1);
    first.name = 'client mutation';
    expect((await readBilibiliProfile({ now: () => instant, cache: context, fetcher })).name).toBe('测试 UP');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fetches only on the profile API path and ignores arbitrary URL/UID queries and request credentials', async () => {
    const fetcher = successfulFetch(), store = new MemoryStore();
    const transaction = vi.spyOn(store, 'transaction');
    const runtime: Runtime = {
      store, bucket: {} as R2Bucket,
      auth: { signIn: vi.fn(), assertSession: vi.fn(), changePassword: vi.fn(), requestPasswordReset: vi.fn(), confirmPasswordReset: vi.fn(), revokeAllSessions: vi.fn() },
      now: () => instant, secureCookies: true, allowedOrigins: ['https://xvyin.invalid'], privacySalt: 'test-only-salt-'.repeat(4), adminUsername: 'test', codeSha: 'a'.repeat(40), bilibiliFetch: fetcher,
    };
    const api = createApi(runtime);
    expect((await api.app.request('/api/v1/health')).status).toBe(200); expect(fetcher).not.toHaveBeenCalled();
    const response = await api.app.request('/api/v1/bilibili/profile?uid=1&url=https://attacker.invalid/', { headers: { cookie: 'secret=value', authorization: 'Bearer private-fixture', 'cf-connecting-ip': '127.0.0.99' } });
    const body = await response.json() as { data: unknown };
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(BilibiliProfileSchema.parse(body.data)).toMatchObject({ uid: BILIBILI_UID, status: 'fresh', authorization: 'public' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(transaction).not.toHaveBeenCalled();
    const request = fetcher.mock.calls[0]![0];
    expect(request.url).toBe('https://api.bilibili.com/x/web-interface/card?mid=520237303');
    expect([...request.headers.keys()]).toEqual(['accept']);
  });
});

describe('dated Bilibili public snapshot fallback', () => {
  const afterCapture = Date.parse(packagedSnapshot.updatedAt) + 48 * HOUR;
  const failingFetch = () => vi.fn<BilibiliFetch>(async () => { throw new Error('Private upstream diagnostics must never be logged'); });

  it('packages only the fixed UID public schema with its original verified capture timestamp', async () => {
    const snapshot = BilibiliProfileSchema.parse(packagedSnapshot);
    expect(snapshot).toMatchObject({ uid: BILIBILI_UID, profileUrl: BILIBILI_PROFILE_URL, status: 'snapshot', authorization: 'public' });
    expect(snapshot.name).toBeTruthy(); expect(snapshot.followers).not.toBeNull();
    expect(Number.isFinite(Date.parse(snapshot.updatedAt!))).toBe(true);
    const result = await readProfile({ now: () => afterCapture, fetcher: failingFetch() });
    expect(result).toEqual(snapshot);
    expect(result.updatedAt).toBe(packagedSnapshot.updatedAt);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ level: 'warn', code: 'BILIBILI_PUBLIC_PROFILE_UNAVAILABLE', reason: 'network' }));
  });

  it.each([
    ['disabled', null],
    ['invalid timestamp', { ...packagedSnapshot, updatedAt: 'invalid' }],
    ['future timestamp', { ...packagedSnapshot, updatedAt: new Date(afterCapture + 1).toISOString() }],
    ['wrong UID', { ...packagedSnapshot, uid: '1' }],
    ['claims fresh', { ...packagedSnapshot, status: 'fresh' }],
    ['claims stale', { ...packagedSnapshot, status: 'stale' }],
    ['extra private data', { ...packagedSnapshot, cookie: 'private-fixture' }],
    ['invalid count', { ...packagedSnapshot, followers: -1 }],
  ])('fails safely when the historical snapshot is %s', async (_label, fallbackSnapshot) => {
    expect((await readBilibiliProfile({ now: () => afterCapture, fetcher: failingFetch(), fallbackSnapshot })).status).toBe('unavailable');
  });

  it('keeps snapshots historical, backs off failures for five minutes, and lets a fresh response supersede them', async () => {
    const cache = edgeCache(), fetcher = failingFetch();
    let clock = afterCapture;
    const read = () => readProfile({ now: () => clock, cache: cache.context, fetcher });
    expect(await read()).toEqual(packagedSnapshot);
    expect(await cache.saved!.clone().json()).toEqual({ profile: null, checkedAt: clock });
    expect(cache.saved?.headers.get('cache-control')).toBe('public, max-age=300');
    clock += 5 * 60_000 - 1;
    expect(await read()).toEqual(packagedSnapshot); expect(fetcher).toHaveBeenCalledTimes(1);
    clock += 1;
    fetcher.mockImplementation(async () => Response.json(example()));
    const fresh = await read();
    expect(fresh).toMatchObject({ status: 'fresh', name: '测试 UP', updatedAt: new Date(clock).toISOString() });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const saved = await cache.saved!.clone().json() as { profile: unknown };
    expect(saved.profile).toEqual(fresh);
  });

  it('prefers retained stale data over the older snapshot and returns the snapshot only after its 24-hour lifetime', async () => {
    const cache = edgeCache(), fetcher = successfulFetch();
    let clock = afterCapture;
    const read = () => readProfile({ now: () => clock, cache: cache.context, fetcher });
    const fresh = await read();
    clock += HOUR;
    fetcher.mockImplementation(async () => Response.json({ code: -352, data: null, message: 'untrusted details' }));
    expect(await read()).toEqual({ ...fresh, status: 'stale' });
    expect(console.warn).toHaveBeenLastCalledWith(JSON.stringify({ level: 'warn', code: 'BILIBILI_PUBLIC_PROFILE_UNAVAILABLE', reason: 'upstream-unavailable' }));
    clock += 23 * HOUR;
    expect(await read()).toEqual(packagedSnapshot);
  });
});
