import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BilibiliBindingStatus, BilibiliQrStart } from '@xvyin/contracts';
import { BilibiliBindingController, validBilibiliQrUrl } from '../src/bilibili-binding';
import { ApiError } from '../src/api';

const binding: BilibiliBindingStatus = { configured: true, uid: '520237303', state: 'unbound', linkedAt: null, credentialsExpireAt: null, lastSyncAt: null, lastAttemptAt: null, lastError: null, profile: null, works: [], worksUpdatedAt: null };
const qr = (): BilibiliQrStart => ({ transactionId: 'test-transaction', qrUrl: 'https://passport.bilibili.com/x/passport-tv-login/h5/qrcode/auth?auth_code=test-only', expiresAt: new Date(Date.now() + 180000).toISOString(), pollAfterMs: 2000 });
const envelope = (data: unknown) => ({ data, meta: { requestId: 'test', schemaVersion: 1 } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('admin Bilibili QR URL boundary', () => {
  it('allows the official verified QR shape', () => { expect(validBilibiliQrUrl(qr().qrUrl)).toBe(true); });
  it.each([
    'http://passport.bilibili.com/x/passport-tv-login/h5/qrcode/auth?auth_code=test',
    'https://passport.bilibili.com.evil.invalid/x/passport-tv-login/h5/qrcode/auth?auth_code=test',
    'https://user:pass@passport.bilibili.com/x/passport-tv-login/h5/qrcode/auth?auth_code=test',
    'https://passport.bilibili.com/x/passport-tv-login/h5/qrcode/auth?auth_code=test&redirect=https://evil.invalid',
    'https://passport.bilibili.com/x/passport-tv-login/h5/qrcode/auth?auth_code=test&auth_code=other',
    'https://passport.bilibili.com/x/passport-tv-login/h5/qrcode/auth?auth_code=test#fragment',
    'https://passport.bilibili.com/other?auth_code=test',
    'https://passport.bilibili.com/x/passport-tv-login/h5/qrcode/auth?auth_code=',
    'https://passport.bilibili.com/x/passport-tv-login/h5/qrcode/auth?auth_code=test\n',
  ])('rejects unsafe QR input without exposing it in errors', value => { expect(validBilibiliQrUrl(value)).toBe(false); });
});

describe('bounded QR lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-26T14:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  it('stops polling and clears QR on successful binding', async () => {
    const request = vi.fn().mockResolvedValueOnce(envelope(binding)).mockResolvedValueOnce(envelope(qr()))
      .mockResolvedValueOnce(envelope({ state: 'scanned' })).mockResolvedValueOnce(envelope({ state: 'bound', binding: { ...binding, state: 'bound', lastSyncAt: new Date().toISOString() } }));
    const controller = new BilibiliBindingController({ request }, vi.fn());
    await controller.load(); await controller.start();
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000); expect(controller.state.qrState).toBe('scanned');
    await vi.advanceTimersByTimeAsync(2000); expect(controller.state.binding?.state).toBe('bound'); expect(controller.state.qr).toBeNull();
    await vi.advanceTimersByTimeAsync(180000); expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[2]?.[1]).toMatchObject({ method: 'POST' });
    controller.dispose();
  });

  it('never overlaps polls, ignores late replies after cancellation, and aborts the active request', async () => {
    const pending = deferred<unknown>();
    const request = vi.fn().mockResolvedValueOnce(envelope(binding)).mockResolvedValueOnce(envelope(qr())).mockReturnValueOnce(pending.promise);
    const controller = new BilibiliBindingController({ request }, vi.fn());
    await controller.load(); await controller.start(); await vi.advanceTimersByTimeAsync(10000);
    expect(request).toHaveBeenCalledTimes(3);
    const signal = request.mock.calls[2]?.[1]?.signal as AbortSignal;
    controller.cancel(); expect(signal.aborted).toBe(true);
    pending.resolve(envelope({ state: 'bound', binding: { ...binding, state: 'bound' } })); await Promise.resolve(); await Promise.resolve();
    expect(controller.state.binding?.state).toBe('unbound'); expect(controller.state.qr).toBeNull();
    await vi.advanceTimersByTimeAsync(180000); expect(request).toHaveBeenCalledTimes(3); controller.dispose();
  });

  it('expires QR and aborts its active poll at the local bounded expiry', async () => {
    const pending = deferred<unknown>();
    const request = vi.fn().mockResolvedValueOnce(envelope(binding)).mockResolvedValueOnce(envelope({ ...qr(), expiresAt: new Date(Date.now() + 5000).toISOString() })).mockReturnValueOnce(pending.promise);
    const controller = new BilibiliBindingController({ request }, vi.fn());
    await controller.load(); await controller.start(); await vi.advanceTimersByTimeAsync(5000);
    expect(controller.state.qrState).toBe('expired'); expect(controller.state.qr).toBeNull();
    expect((request.mock.calls[2]?.[1]?.signal as AbortSignal).aborted).toBe(true);
    pending.resolve(envelope({ state: 'waiting' })); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10000); expect(request).toHaveBeenCalledTimes(3); controller.dispose();
  });

  it('ignores a stale QR creation reply when the panel is disposed', async () => {
    const pending = deferred<unknown>(), changed = vi.fn();
    const request = vi.fn().mockResolvedValueOnce(envelope(binding)).mockReturnValueOnce(pending.promise);
    const controller = new BilibiliBindingController({ request }, changed);
    await controller.load(); const start = controller.start(); controller.dispose(); const count = changed.mock.calls.length;
    pending.resolve(envelope(qr())); await start; await vi.advanceTimersByTimeAsync(200000);
    expect(controller.state.qr).toBeNull(); expect(changed).toHaveBeenCalledTimes(count); expect(request).toHaveBeenCalledTimes(2);
  });

  it('disables QR when configuration is unavailable and does not poll an invalid QR response', async () => {
    const request = vi.fn().mockResolvedValueOnce(envelope({ ...binding, configured: false })).mockResolvedValueOnce(envelope(binding)).mockResolvedValueOnce(envelope({ ...qr(), qrUrl: 'https://evil.invalid' }));
    const controller = new BilibiliBindingController({ request }, vi.fn());
    await controller.load(); await controller.start(); expect(request).toHaveBeenCalledTimes(1);
    await controller.load(); await controller.start(); await vi.advanceTimersByTimeAsync(180000);
    expect(request).toHaveBeenCalledTimes(3); expect(controller.state.error).toContain('二维码响应无效'); expect(controller.state.error).not.toContain('evil.invalid'); expect(controller.state.qr).toBeNull(); controller.dispose();
  });

  it('keeps manual sync errors actionable and uses a mutation for unlink', async () => {
    const request = vi.fn().mockResolvedValueOnce(envelope(binding)).mockRejectedValueOnce(new Error('登录已过期，请重新扫码。')).mockResolvedValueOnce(envelope(binding));
    const controller = new BilibiliBindingController({ request }, vi.fn());
    await controller.load(); await controller.mutate('sync'); expect(controller.state.error).toContain('重新扫码'); expect(controller.state.busy).toBeNull();
    await controller.mutate('unlink'); expect(request).toHaveBeenLastCalledWith('/admin/bilibili/unlink', expect.objectContaining({ method: 'POST' })); expect(controller.state.error).toBe(''); controller.dispose();
  });

  it('explains server-side upstream blocking and does not automatically retry QR creation', async () => {
    const request = vi.fn().mockResolvedValueOnce(envelope(binding)).mockRejectedValueOnce(new ApiError(503, 'BILIBILI_UPSTREAM_BLOCKED', 'upstream unavailable'));
    const controller = new BilibiliBindingController({ request }, vi.fn());
    await controller.load(); await controller.start(); await vi.advanceTimersByTimeAsync(180000);
    expect(controller.state.error).toContain('B 站暂时限制了服务器连接'); expect(request).toHaveBeenCalledTimes(2); expect(controller.state.qr).toBeNull(); controller.dispose();
  });

  it('refreshes the first asynchronous sync after binding, then stops once a result arrives', async () => {
    const linked = { ...binding, state: 'bound' };
    const request = vi.fn().mockResolvedValueOnce(envelope(binding)).mockResolvedValueOnce(envelope(qr())).mockResolvedValueOnce(envelope({ state: 'bound', binding: linked }))
      .mockResolvedValueOnce(envelope(linked)).mockResolvedValueOnce(envelope({ ...linked, lastSyncAt: new Date().toISOString() }));
    const controller = new BilibiliBindingController({ request }, vi.fn());
    await controller.load(); await controller.start(); await vi.advanceTimersByTimeAsync(2000);
    expect(controller.state.qr).toBeNull(); expect(controller.state.notice).toContain('首次同步');
    await vi.advanceTimersByTimeAsync(6000); expect(controller.state.binding?.lastSyncAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60000); expect(request).toHaveBeenCalledTimes(5); controller.dispose();
  });

  it('bounds first-sync status refresh to thirty seconds and cancels it when disposed', async () => {
    const linked = { ...binding, state: 'bound' };
    const request = vi.fn().mockResolvedValueOnce(envelope(binding)).mockResolvedValueOnce(envelope(qr())).mockResolvedValueOnce(envelope({ state: 'bound', binding: linked })).mockResolvedValue(envelope(linked));
    const controller = new BilibiliBindingController({ request }, vi.fn());
    await controller.load(); await controller.start(); await vi.advanceTimersByTimeAsync(32000);
    expect(controller.state.notice).toContain('暂未读取到首次同步结果');
    const count = request.mock.calls.length; await vi.advanceTimersByTimeAsync(180000); expect(request).toHaveBeenCalledTimes(count);
    controller.dispose();
  });
});
