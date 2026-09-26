import type { BilibiliBindingStatus, BilibiliQrPoll, BilibiliQrStart } from '@xvyin/contracts';
import { ApiError, errorMessage, type AdminApi } from './api';

export interface BindingView {
  binding: BilibiliBindingStatus | null;
  busy: 'loading' | 'starting' | 'syncing' | 'unlinking' | null;
  qr: BilibiliQrStart | null;
  qrState: 'idle' | 'waiting' | 'scanned' | 'expired' | 'rejected';
  error: string;
  notice: string;
}
export const emptyBindingView = (): BindingView => ({ binding: null, busy: null, qr: null, qrState: 'idle', error: '', notice: '' });

export function validBilibiliQrUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://passport.bilibili.com' && !url.username && !url.password && !url.port && !url.hash
      && url.pathname === '/x/passport-tv-login/h5/qrcode/auth'
      && [...url.searchParams.keys()].length === 1
      && /^[A-Za-z0-9_-]{1,512}$/u.test(url.searchParams.get('auth_code') || '');
  } catch { return false; }
}

/** A panel owns this controller. All QR state stays in memory and dies with the panel. */
export class BilibiliBindingController {
  private value = emptyBindingView();
  private generation = 0;
  private disposed = false;
  private requestAbort?: AbortController;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly api: Pick<AdminApi, 'request'>, private readonly changed: (view: BindingView) => void) {}
  get state(): BindingView { return { ...this.value }; }
  private update(change: Partial<BindingView>) { if (!this.disposed) { this.value = { ...this.value, ...change }; this.changed(this.state); } }
  private clear() {
    this.generation++; this.requestAbort?.abort(); this.requestAbort = undefined;
    clearTimeout(this.pollTimer); clearTimeout(this.expiryTimer); this.pollTimer = undefined; this.expiryTimer = undefined;
  }
  private current(generation: number) { return !this.disposed && this.generation === generation; }
  private begin(busy: BindingView['busy']) {
    this.clear(); this.update({ busy, qr: null, qrState: 'idle', error: '', notice: '' });
    return this.generation;
  }
  private async request<T>(path: string, method = 'GET'): Promise<T> {
    const abort = new AbortController(); this.requestAbort = abort;
    const timeout = setTimeout(() => abort.abort(), 20000);
    try { return (await this.api.request<T>(path, { method, signal: abort.signal })).data; }
    finally { clearTimeout(timeout); if (this.requestAbort === abort) this.requestAbort = undefined; }
  }
  private fail(error: unknown, fallback: string) {
    if (error instanceof ApiError && error.code === 'BILIBILI_UPSTREAM_BLOCKED') return 'B 站暂时限制了服务器连接，暂时无法生成二维码或同步，请稍后重试。';
    return error instanceof DOMException && error.name === 'AbortError' ? fallback : errorMessage(error);
  }
  async load() {
    if (this.disposed) return;
    const generation = this.begin('loading');
    try { const binding = await this.request<BilibiliBindingStatus>('/admin/bilibili'); if (this.current(generation)) this.update({ binding }); }
    catch (error) { if (this.current(generation)) this.update({ error: this.fail(error, '读取绑定状态超时，请重新读取。') }); }
    finally { if (this.current(generation)) this.update({ busy: null }); }
  }
  async start() {
    if (this.disposed || !this.value.binding?.configured) return;
    const generation = this.begin('starting');
    try {
      const qr = await this.request<BilibiliQrStart>('/admin/bilibili/qr', 'POST');
      if (!this.current(generation)) return;
      const remaining = Math.min(Date.parse(qr.expiresAt) - Date.now(), 180000);
      if (!validBilibiliQrUrl(qr.qrUrl) || typeof qr.transactionId !== 'string' || /\s/u.test(qr.transactionId) || !/^[A-Za-z0-9_-]{1,128}$/u.test(qr.transactionId) || !Number.isFinite(remaining) || remaining <= 0) throw new Error('二维码响应无效或已过期，请重新生成。');
      this.update({ qr, qrState: 'waiting' });
      this.expiryTimer = setTimeout(() => { if (this.current(generation)) { this.clear(); this.update({ qr: null, qrState: 'expired', busy: null, notice: '二维码已过期，请重新生成。' }); } }, remaining);
      this.schedulePoll(generation, qr);
    } catch (error) { if (this.current(generation)) this.update({ error: this.fail(error, '生成二维码超时，请重试。') }); }
    finally { if (this.current(generation)) this.update({ busy: null }); }
  }
  private schedulePoll(generation: number, qr: BilibiliQrStart) {
    this.pollTimer = setTimeout(() => { void this.poll(generation, qr); }, Math.min(10000, Math.max(2000, Number.isFinite(qr.pollAfterMs) ? qr.pollAfterMs : 2000)));
  }
  private async poll(generation: number, qr: BilibiliQrStart) {
    if (!this.current(generation)) return;
    try {
      const result = await this.request<BilibiliQrPoll>(`/admin/bilibili/qr/${encodeURIComponent(qr.transactionId)}/poll`, 'POST');
      if (!this.current(generation)) return;
      if (result.state === 'waiting' || result.state === 'scanned') {
        this.update({ qrState: result.state }); this.schedulePoll(generation, qr); return;
      }
      this.clear();
      if (result.state === 'bound') {
        this.update({ qr: null, qrState: 'idle', notice: 'B 站账号已绑定，正在等待首次同步结果…', ...(result.binding ? { binding: result.binding } : {}) });
        if (!result.binding) await this.load();
        if (this.value.binding?.state === 'bound' && !this.value.binding.lastSyncAt && !this.value.binding.lastError) this.awaitFirstSync();
        else this.update({ notice: 'B 站账号已绑定，请查看同步结果与更新时间。' });
      } else this.update({ qr: null, qrState: result.state === 'expired' ? 'expired' : 'rejected', notice: result.state === 'expired' ? '二维码已过期，请重新生成。' : '这次绑定未完成，请使用 UID 520237303 的 B 站账号重新扫码。' });
    } catch (error) {
      if (!this.current(generation)) return;
      this.clear(); this.update({ qr: null, qrState: 'idle', error: `${this.fail(error, '查询登录状态超时。')} 请重新读取绑定状态，或重新生成二维码。` });
    }
  }
  private awaitFirstSync() {
    const generation = this.generation;
    this.expiryTimer = setTimeout(() => {
      if (this.current(generation)) { this.clear(); this.update({ notice: '绑定成功，暂未读取到首次同步结果，可稍后重新读取状态。' }); }
    }, 30000);
    const refresh = async () => {
      if (!this.current(generation)) return;
      try {
        const binding = await this.request<BilibiliBindingStatus>('/admin/bilibili');
        if (!this.current(generation)) return;
        this.update({ binding });
        if (binding.lastSyncAt || binding.lastError || binding.state !== 'bound') { this.clear(); this.update({ notice: '已读取最新同步状态，请查看更新时间及提示。' }); }
        else this.pollTimer = setTimeout(() => { void refresh(); }, 3000);
      } catch (error) {
        if (!this.current(generation)) return;
        this.clear(); this.update({ notice: '绑定已完成，暂时无法读取同步结果，请稍后重新读取状态。' });
      }
    };
    this.pollTimer = setTimeout(() => { void refresh(); }, 3000);
  }
  cancel() { this.clear(); this.update({ qr: null, qrState: 'idle', busy: null, notice: '已停止扫码等待；如已在 B 站确认，请重新读取绑定状态。' }); }
  async mutate(action: 'sync' | 'unlink') {
    if (this.disposed) return;
    const generation = this.begin(action === 'sync' ? 'syncing' : 'unlinking');
    try {
      const binding = await this.request<BilibiliBindingStatus>(`/admin/bilibili/${action}`, 'POST');
      if (this.current(generation)) this.update({ binding, notice: action === 'sync' ? '同步请求已完成，请查看更新时间和同步状态。' : '本站保存的 B 站登录凭据已移除，自动同步已停止。' });
    } catch (error) { if (this.current(generation)) this.update({ error: this.fail(error, '操作超时，请重新读取状态确认结果。') }); }
    finally { if (this.current(generation)) this.update({ busy: null }); }
  }
  dispose() { this.clear(); this.disposed = true; this.value = emptyBindingView(); }
}
