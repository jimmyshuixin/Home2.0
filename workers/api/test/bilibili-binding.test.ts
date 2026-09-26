import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { BILIBILI_UID } from '@xvyin/contracts';
import { BilibiliBinding } from '../src/bilibili-binding';
import { biliJson, tvForm } from '../src/bilibili-transport';
import type { BilibiliFetch } from '../src/bilibili';
import { MemoryStore } from '../src/store/memory';

const KEY = 'ab'.repeat(32), AUTH_CODE = 'qr-code-fixture-0123456789abcdef';
const NOW = Date.UTC(2026, 8, 26, 15), HOUR = 3600_000;
const BV = 'BV17x411w7KC';
const login = (uid = BILIBILI_UID) => ({ token_info: { mid: uid, access_token: 'access-fixture-0123456789', refresh_token: 'refresh-fixture-0123456789', expires_in: 30 * 24 * 3600 }, cookie_info: { cookies: [{ name: 'SESSDATA', value: 'cookie-fixture-0123456789' }, { name: 'bili_jct', value: 'csrf-fixture-0123456789' }, { name: 'DedeUserID', value: uid }, { name: 'ignored-private-cookie', value: 'excluded-fixture' }] } });
const nav = () => ({ mid: BILIBILI_UID, isLogin: true, wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/' + 'a'.repeat(32) + '.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/' + 'b'.repeat(32) + '.png' }, money: 123, email: 'private-fixture' });
const card = () => ({ card: { mid: BILIBILI_UID, name: '测试作者', sign: '公开简介', face: 'https://i0.hdslb.com/bfs/face/avatar.jpg' }, follower: 12, archive_count: 34, like_num: 56 });
const view = () => ({ bvid: BV, state: 0, owner: { mid: BILIBILI_UID }, title: '<b>公开作品</b>', pic: 'http://i2.hdslb.com/bfs/archive/image.jpg', pubdate: Math.floor(NOW / 1000) - 3600, duration: 300, stat: { view: 987 }, private_field: 'excluded-work-fixture' });
function fixture() {
  let clock = NOW;
  const store = new MemoryStore();
  const overrides = new Map<string, (request: Request) => Response | Promise<Response>>();
  const fetcher = vi.fn<BilibiliFetch>(async request => {
    const path = new URL(request.url).pathname;
    if (overrides.has(path)) return overrides.get(path)!(request);
    if (path.endsWith('/auth_code')) return Response.json({ code: 0, data: { auth_code: AUTH_CODE, url: `https://passport.bilibili.com/x/passport-tv-login/h5/qrcode/auth?auth_code=${AUTH_CODE}` } });
    if (path.endsWith('/qrcode/poll')) return Response.json({ code: 0, data: login() });
    if (path.endsWith('/oauth2/refresh_token')) return Response.json({ code: 0, data: login() });
    if (path.endsWith('/nav')) return Response.json({ code: 0, data: nav() });
    if (path.endsWith('/card')) return Response.json({ code: 0, data: card() });
    if (path.endsWith('/arc/search')) return Response.json({ code: 0, data: { list: { vlist: [{ bvid: BV, private_field: 'not-published' }] } } });
    if (path.endsWith('/view')) return Response.json({ code: 0, data: view() });
    throw new Error('Unexpected fixture endpoint');
  });
  const service = new BilibiliBinding(store, () => clock, { credentialKey: KEY, fetcher });
  const bind = async () => { const qr = await service.startQr('admin-session-one'); expect((await service.pollQr('admin-session-one', qr.transactionId)).state).toBe('bound'); return qr; };
  return { store, fetcher, service, bind, overrides, advance: (ms: number) => { clock += ms; }, get clock() { return clock; } };
}
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Bilibili server QR binding', () => {
  it('fails closed before network/storage when the independent encryption secret is missing or malformed', async () => {
    const f = fixture();
    for (const credentialKey of [undefined, '', 'weak', 'a'.repeat(63)]) {
      const service = new BilibiliBinding(f.store, () => NOW, { credentialKey, fetcher: f.fetcher });
      expect((await service.adminStatus()).configured).toBe(false);
      await expect(service.startQr('session')).rejects.toMatchObject({ code: 'BILIBILI_NOT_CONFIGURED' });
    }
    expect(f.fetcher).not.toHaveBeenCalled(); expect((await f.store.list('bilibili_qr')).items).toEqual([]);
  });

  it('encrypts one QR record per admin session, rejects other sessions, enforces TTL and bounds restarts', async () => {
    const f = fixture(), first = await f.service.startQr('admin-session-one');
    const records = await f.store.list('bilibili_qr');
    expect(JSON.stringify(records)).not.toContain(AUTH_CODE); expect(JSON.stringify(records)).not.toContain('passport.bilibili.com');
    expect(Date.parse(first.expiresAt) - NOW).toBe(180_000);
    expect(await f.service.pollQr('other-admin-session', first.transactionId)).toEqual({ state: 'expired' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const second = await f.service.startQr('admin-session-one');
    expect((await f.store.list('bilibili_qr')).items).toHaveLength(1);
    expect(await f.service.pollQr('admin-session-one', first.transactionId)).toEqual({ state: 'expired' });
    f.advance(180_000);
    expect(await f.service.pollQr('admin-session-one', second.transactionId)).toEqual({ state: 'expired' });
    expect((await f.store.list('bilibili_qr')).items).toHaveLength(0);
  });

  it('validates the exact QR HTTPS origin/path and auth-code association', async () => {
    const f = fixture();
    f.overrides.set('/x/passport-tv-login/qrcode/auth_code', () => Response.json({ code: 0, data: { auth_code: AUTH_CODE, url: `https://passport.bilibili.com.attacker.invalid/x/passport-tv-login/h5/qrcode/auth?auth_code=${AUTH_CODE}` } }));
    await expect(f.service.startQr('session')).rejects.toMatchObject({ code: 'BILIBILI_QR_UNAVAILABLE' });
    expect((await f.store.list('bilibili_qr')).items).toHaveLength(0);
  });

  it('throttles QR polling and handles waiting/scanned states without exposing an auth code', async () => {
    const f = fixture(), qr = await f.service.startQr('admin-session-one');
    f.overrides.set('/x/passport-tv-login/qrcode/poll', () => Response.json({ code: 86039 }));
    expect(await f.service.pollQr('admin-session-one', qr.transactionId)).toEqual({ state: 'waiting' });
    const count = f.fetcher.mock.calls.length;
    expect(await f.service.pollQr('admin-session-one', qr.transactionId)).toEqual({ state: 'waiting' });
    expect(f.fetcher).toHaveBeenCalledTimes(count);
    f.advance(2000); f.overrides.set('/x/passport-tv-login/qrcode/poll', () => Response.json({ code: 86090 }));
    expect(await f.service.pollQr('admin-session-one', qr.transactionId)).toEqual({ state: 'scanned' });
  });

  it('verifies both token UID and authenticated nav identity before storing credentials; wrong account preserves the existing binding', async () => {
    const f = fixture(); await f.bind();
    const original = await f.store.get('bilibili_binding/account');
    let qr = await f.service.startQr('admin-session-one');
    f.overrides.set('/x/passport-tv-login/qrcode/poll', () => Response.json({ code: 0, data: login('1' as typeof BILIBILI_UID) }));
    expect(await f.service.pollQr('admin-session-one', qr.transactionId)).toEqual({ state: 'rejected' });
    expect(await f.store.get('bilibili_binding/account')).toEqual(original);
    f.overrides.delete('/x/passport-tv-login/qrcode/poll');
    qr = await f.service.startQr('admin-session-one');
    f.overrides.set('/x/web-interface/nav', () => Response.json({ code: 0, data: { ...nav(), mid: '1' } }));
    expect(await f.service.pollQr('admin-session-one', qr.transactionId)).toEqual({ state: 'rejected' });
    expect(await f.store.get('bilibili_binding/account')).toEqual(original);
  });

  it('stores AES-GCM envelopes only and returns no cookies/tokens/login URLs through status, sync or public data', async () => {
    const f = fixture(); await f.bind();
    const synced = await f.service.sync();
    expect(synced).toMatchObject({ state: 'bound', lastError: null, profile: { followers: 12 }, works: [{ bvid: BV, title: '公开作品', views: 987 }] });
    const persisted = JSON.stringify(await f.store.get('bilibili_binding/account'));
    const publicValues = JSON.stringify([await f.service.adminStatus(), await f.service.publicData(), synced]);
    for (const secret of ['cookie-fixture', 'access-fixture', 'refresh-fixture', 'csrf-fixture', 'excluded-fixture', AUTH_CODE]) { expect(persisted).not.toContain(secret); expect(publicValues).not.toContain(secret); }
    for (const secret of ['SESSDATA', 'bili_jct', 'private-fixture', 'excluded-work-fixture', 'auth_code', 'passport.bilibili.com']) expect(publicValues).not.toContain(secret);
    const requests = f.fetcher.mock.calls.map(([request]) => request);
    expect(requests.every(request => request.redirect === 'manual')).toBe(true);
    expect(requests.every(request => ['api.bilibili.com', 'passport.bilibili.com'].includes(new URL(request.url).hostname))).toBe(true);
    const publicView = requests.find(request => new URL(request.url).pathname.endsWith('/view'))!;
    expect(publicView.headers.has('cookie')).toBe(false);
    expect(requests.find(request => new URL(request.url).pathname.endsWith('/nav'))!.headers.get('cookie')).toContain('SESSDATA=');
    expect(requests.some(request => /access-fixture|refresh-fixture|cookie-fixture/u.test(request.url))).toBe(false);
  });

  it('does not publish owner-only or different-owner works even if the authenticated list includes them', async () => {
    const f = fixture(); await f.bind();
    f.overrides.set('/x/web-interface/view', () => Response.json({ code: -404, message: 'private fixture' }));
    const status = await f.service.sync();
    expect(status.works).toEqual([]); expect(status.lastError).toBeNull();
    f.advance(6 * HOUR); f.overrides.set('/x/web-interface/view', () => Response.json({ code: 0, data: { ...view(), owner: { mid: '1' } } }));
    expect((await f.service.sync()).works).toEqual([]);
  });

  it('detects a changed encryption key or modified ciphertext and preserves last-good public data', async () => {
    const f = fixture(); await f.bind(); await f.service.sync();
    const previous = await f.service.publicData();
    const wrongKey = new BilibiliBinding(f.store, () => f.clock, { credentialKey: 'cd'.repeat(32), fetcher: f.fetcher });
    const count = f.fetcher.mock.calls.length;
    expect(await wrongKey.sync()).toMatchObject({ state: 'expired', lastError: 'credentials-unavailable' });
    expect(f.fetcher).toHaveBeenCalledTimes(count); expect(await wrongKey.publicData()).toEqual(previous);
    await f.store.transaction(async tx => { const record = await tx.get<Record<string, unknown>>('bilibili_binding/account'); tx.put('bilibili_binding/account', { ...record, encrypted: { v: 1, iv: 'not-base64', ciphertext: 'tampered' } }); });
    expect(await f.service.sync()).toMatchObject({ state: 'expired', lastError: 'credentials-unavailable' });
  });

  it('removes a formerly public work after an anonymous -404 instead of merging it from the old snapshot', async () => {
    const f = fixture(), other = 'BV1GJ411x7h7'; await f.bind();
    f.overrides.set('/x/space/wbi/arc/search', () => Response.json({ code: 0, data: { list: { vlist: [{ bvid: BV }, { bvid: other }] } } }));
    f.overrides.set('/x/web-interface/view', request => Response.json({ code: 0, data: { ...view(), bvid: new URL(request.url).searchParams.get('bvid') } }));
    expect((await f.service.sync()).works).toHaveLength(2);
    f.advance(6 * HOUR);
    f.overrides.set('/x/web-interface/view', request => new URL(request.url).searchParams.get('bvid') === BV ? Response.json({ code: -404 }) : Response.json({ code: 0, data: { ...view(), bvid: other } }));
    const status = await f.service.sync();
    expect(status.works.map(work => work.bvid)).toEqual([other]); expect(status.worksUpdatedAt).toBe(new Date(f.clock).toISOString());
  });

  it('persists rotated TV credentials before a later identity outage and uses the new cookie on retry', async () => {
    const f = fixture(); await f.bind(); await f.service.sync();
    f.advance(30 * 24 * HOUR - HOUR);
    const renewed = login(); renewed.token_info.access_token = 'rotated-access-fixture'; renewed.token_info.refresh_token = 'rotated-refresh-fixture'; renewed.cookie_info.cookies[0]!.value = 'rotated-cookie-fixture';
    f.overrides.set('/x/passport-login/oauth2/refresh_token', () => Response.json({ code: 0, data: renewed }));
    f.overrides.set('/x/web-interface/nav', () => new Response('blocked private fixture', { status: 412 }));
    expect(await f.service.sync()).toMatchObject({ state: 'bound', lastError: 'upstream-blocked' });
    const stored = await f.store.get<{ encrypted: { iv: string; ciphertext: string } }>('bilibili_binding/account');
    const raw = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(KEY.match(/../gu)!, value => parseInt(value, 16)), 'AES-GCM', false, ['decrypt']);
    const decoded = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw(stored!.encrypted.iv), additionalData: new TextEncoder().encode(`bilibili:credentials:v1:${BILIBILI_UID}`) }, key, raw(stored!.encrypted.ciphertext))));
    expect(decoded.accessToken).toBe('rotated-access-fixture'); expect(decoded.refreshToken).toBe('rotated-refresh-fixture');
    f.overrides.delete('/x/web-interface/nav');
    expect((await f.service.sync()).state).toBe('bound');
    const requests = f.fetcher.mock.calls.map(([request]) => request).filter(request => new URL(request.url).pathname.endsWith('/nav'));
    expect(requests.at(-1)!.headers.get('cookie')).toContain('rotated-cookie-fixture');
  });

  it('fences an older pending poll from overwriting a newer successful binding after the poll lease expires', async () => {
    const f = fixture(), qr = await f.service.startQr('admin-session-one');
    let release!: () => void, calls = 0;
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.overrides.set('/x/passport-tv-login/qrcode/poll', async () => { calls++; if (calls === 1) { await pending; return Response.json({ code: 86039 }); } return Response.json({ code: 0, data: login() }); });
    const old = f.service.pollQr('admin-session-one', qr.transactionId);
    await vi.waitFor(() => expect(calls).toBe(1));
    f.advance(16000);
    expect((await f.service.pollQr('admin-session-one', qr.transactionId)).state).toBe('bound');
    release(); await old;
    expect(await f.service.pollQr('admin-session-one', qr.transactionId)).toEqual({ state: 'bound' });
    expect((await f.service.adminStatus()).state).toBe('bound');
  });

  it('preserves last-good sections on partial or complete upstream failures and respects the six-hour scheduled interval', async () => {
    const f = fixture(); await f.bind(); await f.service.sync();
    const first = await f.service.publicData(), count = f.fetcher.mock.calls.length;
    await f.service.sync(false); expect(f.fetcher).toHaveBeenCalledTimes(count);
    f.advance(6 * HOUR);
    f.overrides.set('/x/space/wbi/arc/search', () => Response.json({ code: -352, data: null }));
    expect(await f.service.sync(false)).toMatchObject({ state: 'bound', lastError: 'partial-sync', works: first!.works, worksUpdatedAt: first!.worksUpdatedAt });
    const lastProfile = (await f.service.publicData())!.profile;
    f.advance(6 * HOUR);
    f.overrides.set('/x/web-interface/card', () => new Response('<html>blocked</html>', { status: 412 }));
    expect(await f.service.sync(false)).toMatchObject({ state: 'bound', lastError: 'upstream-unavailable', works: first!.works, profile: { updatedAt: lastProfile.updatedAt } });
  });

  it('refreshes with the TV platform over POST and marks expired credentials without erasing public data', async () => {
    const f = fixture(); await f.bind(); await f.service.sync();
    const previous = await f.service.publicData();
    f.advance(30 * 24 * HOUR);
    f.overrides.set('/x/passport-login/oauth2/refresh_token', () => Response.json({ code: -101, message: 'expired private detail' }));
    expect(await f.service.sync()).toMatchObject({ state: 'expired', lastError: 'login-expired', works: previous!.works });
    const refresh = f.fetcher.mock.calls.map(([request]) => request).find(request => new URL(request.url).pathname.endsWith('/refresh_token'))!;
    expect(refresh.method).toBe('POST'); expect(refresh.url).not.toContain('access');
    const form = new URLSearchParams(await refresh.text()); expect(form.get('appkey')).toBe('4409e2ce8ffd12b8'); expect(form.get('refresh_token')).toBe('refresh-fixture-0123456789');
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('expired private detail');
  });

  it('unlink clears local credentials, invalidates pending QR transactions and prevents a racing sync from restoring data', async () => {
    const f = fixture(); await f.bind(); await f.service.sync();
    const qr = await f.service.startQr('admin-session-one');
    expect(await f.service.unlink()).toMatchObject({ state: 'unbound', credentialsExpireAt: null, profile: { status: 'snapshot' } });
    expect(await f.service.pollQr('admin-session-one', qr.transactionId)).toEqual({ state: 'expired' });
    expect(await f.store.get('bilibili_binding/account')).toMatchObject({ encrypted: null });
    await f.bind();
    let resume!: () => void;
    const blocked = new Promise<void>(resolve => { resume = resolve; });
    f.overrides.set('/x/web-interface/card', async () => { await blocked; return Response.json({ code: 0, data: card() }); });
    const syncing = f.service.sync();
    await vi.waitFor(() => expect(f.fetcher.mock.calls.filter(([request]) => new URL(request.url).pathname.endsWith('/card')).length).toBeGreaterThan(1));
    await f.service.unlink(); resume(); await syncing;
    expect(await f.service.adminStatus()).toMatchObject({ state: 'unbound', profile: { status: 'snapshot' } });
    expect(await f.store.get('bilibili_binding/account')).toMatchObject({ encrypted: null });
  });
});

describe('Bilibili fixed-host transport', () => {
  it('uses deterministic platform signing and never follows a redirect carrying credentials', async () => {
    const form = tvForm(NOW, { local_id: '0' });
    expect(form.get('sign')).toMatch(/^[a-f0-9]{32}$/u);
    const fetcher = vi.fn<BilibiliFetch>(async () => new Response('', { status: 302, headers: { location: 'https://attacker.invalid/' } }));
    await expect(biliJson(fetcher, 'https://api.bilibili.com/x/web-interface/nav', { cookie: 'SESSDATA=fixture' })).rejects.toMatchObject({ reason: 'upstream-blocked' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0]![0].redirect).toBe('manual');
    await expect(biliJson(fetcher, 'https://api.bilibili.com.attacker.invalid/x')).rejects.toMatchObject({ reason: 'invalid-response' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds malformed, oversized and indefinitely slow upstream responses', async () => {
    await expect(biliJson(async () => new Response('{bad'), 'https://api.bilibili.com/x')).rejects.toMatchObject({ reason: 'invalid-response' });
    await expect(biliJson(async () => new Response('x'.repeat(262145)), 'https://api.bilibili.com/x')).rejects.toMatchObject({ reason: 'invalid-response' });
    vi.useFakeTimers();
    const stalled = biliJson(async () => new Promise(() => {}), 'https://api.bilibili.com/x');
    const expected = expect(stalled).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(5000); await expected;
  });
});
