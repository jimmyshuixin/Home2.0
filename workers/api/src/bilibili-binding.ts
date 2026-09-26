import { z } from 'zod';
import { BILIBILI_UID, BilibiliProfileSchema, BilibiliWorkSchema, isBilibiliCoverUrl, type BilibiliProfile, type BilibiliWork, type BilibiliBindingStatus, type BilibiliQrStart, type BilibiliQrPoll } from '@xvyin/contracts';
import type { Store } from './store/types';
import { ApiError, assert } from './errors';
import { sha256 } from './security';
import { sanitizeBilibiliProfile, type BilibiliFetch } from './bilibili';
import { biliJson, biliRecord, biliText, biliCount, tvForm, publicWorksQuery, BilibiliUpstreamError } from './bilibili-transport';
import packagedSnapshot from './bilibili-profile-snapshot.json';

const BINDING = 'bilibili_binding/account', PUBLIC = 'bilibili_public/account';
const HOUR = 3600_000, QR_TTL = 180_000;
const encryptedSchema = z.object({ v: z.literal(1), iv: z.string().max(64), ciphertext: z.string().max(64000) }).strict();
type Encrypted = z.infer<typeof encryptedSchema>;
const credentialSchema = z.object({
  uid: z.literal(BILIBILI_UID), accessToken: z.string().min(10).max(4096), refreshToken: z.string().min(10).max(4096),
  expiresAt: z.number().int().nonnegative(), cookies: z.object({ SESSDATA: z.string().min(1).max(4096), bili_jct: z.string().min(1).max(256), DedeUserID: z.literal(BILIBILI_UID) }).strict(),
}).strict();
type Credentials = z.infer<typeof credentialSchema>;
interface BindingRecord {
  revision: string; state: 'unbound' | 'bound' | 'expired'; encrypted: Encrypted | null; linkedAt: number | null;
  expiresAt: number | null; lastSyncAt: number | null; lastAttemptAt: number | null; lastError: string | null; leaseUntil: number; syncAttempt: string | null;
}
interface QrRecord { id: string; scope: string; expiresAt: number; encrypted: Encrypted | null; baseRevision: string | null; nextPollAt: number; leaseUntil: number; pollAttempt: string | null; state: BilibiliQrPoll['state'] }
class NonPublicWork extends Error {}
const publicSchema = z.object({ profile: BilibiliProfileSchema, works: z.array(BilibiliWorkSchema).max(12), worksUpdatedAt: z.string().datetime().nullable() }).strict();
export type BilibiliPublicData = z.infer<typeof publicSchema>;
const iso = (value: number | null | undefined): string | null => typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const credentialScope = `bilibili:credentials:v1:${BILIBILI_UID}`;

/** Server-only integration. Its public methods return explicit projections only. */
export class BilibiliBinding {
  private readonly fetcher: BilibiliFetch;
  constructor(private readonly store: Store, private readonly now: () => number, private readonly options: { credentialKey?: string; fetcher?: BilibiliFetch } = {}) {
    this.fetcher = options.fetcher || (request => fetch(request));
  }
  get configured(): boolean { return /^[a-fA-F0-9]{64}$/u.test(this.options.credentialKey || ''); }
  private async key(): Promise<CryptoKey> {
    assert(this.configured, 'BILIBILI_NOT_CONFIGURED', 503, 'B站加密存储尚未配置');
    const bytes = Uint8Array.from(this.options.credentialKey!.match(/../gu)!, value => parseInt(value, 16));
    return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  private async seal(value: unknown, scope: string): Promise<Encrypted> {
    const key = await this.key(), iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    assert(encoded.byteLength < 32000, 'BILIBILI_INVALID_CREDENTIALS', 502, 'B站登录响应无效');
    const result = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(scope) }, key, encoded);
    return { v: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(result)) };
  }
  private async unseal(value: Encrypted, scope: string): Promise<unknown> {
    try {
      const envelope = encryptedSchema.parse(value), iv = fromBase64(envelope.iv);
      if (iv.byteLength !== 12) throw new Error();
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(scope) }, await this.key(), fromBase64(envelope.ciphertext));
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decrypted)) as unknown;
    } catch { throw new ApiError('BILIBILI_CREDENTIALS_UNAVAILABLE', 503, 'B站凭据不可用，请重新扫码绑定'); }
  }
  private empty(): BindingRecord { return { revision: crypto.randomUUID(), state: 'unbound', encrypted: null, linkedAt: null, expiresAt: null, lastSyncAt: null, lastAttemptAt: null, lastError: null, leaseUntil: 0, syncAttempt: null }; }
  private async cleanupQr(): Promise<void> {
    const page = await this.store.list<QrRecord>('bilibili_qr', { limit: 50 });
    for (const item of page.items) if (item.data.expiresAt <= this.now()) await this.store.transaction(async tx => { const current = await tx.get<QrRecord>(`bilibili_qr/${item.id}`); if (current && current.expiresAt <= this.now()) tx.delete(`bilibili_qr/${item.id}`); });
  }
  async publicData(): Promise<BilibiliPublicData | null> {
    const parsed = publicSchema.safeParse(await this.store.get(PUBLIC));
    if (!parsed.success) return null;
    const value = parsed.data, now = this.now(), capturedAt = Date.parse(value.profile.updatedAt || '');
    if (!Number.isFinite(capturedAt) || capturedAt > now || (value.worksUpdatedAt && Date.parse(value.worksUpdatedAt) > now)) return null;
    const age = now - capturedAt;
    return { ...value, profile: { ...value.profile, status: value.profile.status === 'snapshot' || age >= 24 * HOUR ? 'snapshot' : age >= 6 * HOUR ? 'stale' : 'fresh' } };
  }
  async adminStatus(): Promise<BilibiliBindingStatus> {
    const [binding, data] = await Promise.all([this.store.get<BindingRecord>(BINDING), this.publicData()]);
    return { configured: this.configured, uid: BILIBILI_UID, state: binding?.state || 'unbound', linkedAt: iso(binding?.linkedAt), credentialsExpireAt: iso(binding?.expiresAt), lastSyncAt: iso(binding?.lastSyncAt), lastAttemptAt: iso(binding?.lastAttemptAt), lastError: binding?.lastError || null, profile: data?.profile || null, works: data?.works || [], worksUpdatedAt: data?.worksUpdatedAt || null };
  }
  async startQr(sessionId: string): Promise<BilibiliQrStart> {
    await this.key(); // Fail before any network call or storage if encryption is missing.
    await this.cleanupQr();
    const scope = await sha256(sessionId), existing = await this.store.get<BindingRecord>(BINDING);
    const result = await this.upstream(() => biliJson(this.fetcher, 'https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code', { form: tvForm(this.now(), { local_id: '0' }) }));
    const data = biliRecord(result.data), authCode = data?.auth_code, qr = data?.url;
    assert(result.code === 0 && typeof authCode === 'string' && /^[A-Za-z0-9_-]{16,512}$/u.test(authCode) && typeof qr === 'string' && qr.length <= 4096, 'BILIBILI_QR_UNAVAILABLE', 502, 'B站二维码暂时不可用，请稍后重试');
    let valid = false;
    try { const url = new URL(qr); valid = url.origin === 'https://passport.bilibili.com' && !url.username && !url.password && !url.port && !url.hash && url.pathname === '/x/passport-tv-login/h5/qrcode/auth' && [...url.searchParams.keys()].length === 1 && url.searchParams.get('auth_code') === authCode; } catch { /* Rejected below. */ }
    assert(valid, 'BILIBILI_QR_UNAVAILABLE', 502, 'B站二维码暂时不可用，请稍后重试');
    const id = crypto.randomUUID(), expiresAt = this.now() + QR_TTL;
    const encrypted = await this.seal({ authCode }, `bilibili:qr:v1:${scope}:${id}`);
    const record: QrRecord = { id, scope, expiresAt, encrypted, baseRevision: existing?.revision || null, nextPollAt: 0, leaseUntil: 0, pollAttempt: null, state: 'waiting' };
    await this.store.transaction(async tx => { await tx.get(`bilibili_qr/${scope}`); tx.put(`bilibili_qr/${scope}`, record); });
    return { transactionId: id, qrUrl: qr, expiresAt: new Date(expiresAt).toISOString(), pollAfterMs: 2000 };
  }
  private parseCredentials(value: unknown): Credentials {
    const data = biliRecord(value), token = biliRecord(data?.token_info), info = biliRecord(data?.cookie_info);
    if (!token || String(token.mid) !== BILIBILI_UID) throw new BilibiliUpstreamError('wrong-account');
    const cookies: Record<string, string> = {};
    if (Array.isArray(info?.cookies)) for (const raw of info.cookies.slice(0, 30)) {
      const item = biliRecord(raw);
      if (typeof item?.name === 'string' && ['SESSDATA', 'bili_jct', 'DedeUserID'].includes(item.name)) {
        if (typeof item.value !== 'string' || !/^[\x21-\x7e]+$/u.test(item.value) || /[;,]/u.test(item.value) || Object.hasOwn(cookies, item.name)) throw new BilibiliUpstreamError('invalid-response');
        cookies[item.name] = item.value;
      }
    }
    if (cookies.DedeUserID !== BILIBILI_UID) throw new BilibiliUpstreamError('wrong-account');
    const seconds = biliCount(token.expires_in);
    if (!seconds || seconds > 366 * 24 * 3600) throw new BilibiliUpstreamError('invalid-response');
    const parsed = credentialSchema.safeParse({ uid: BILIBILI_UID, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: this.now() + seconds * 1000, cookies });
    if (!parsed.success) throw new BilibiliUpstreamError('invalid-response'); return parsed.data;
  }
  private cookie(credentials: Credentials): string { return Object.entries(credentials.cookies).map(([name, value]) => `${name}=${value}`).join('; '); }
  private async identity(credentials: Credentials): Promise<Record<string, unknown>> {
    const result = await biliJson(this.fetcher, 'https://api.bilibili.com/x/web-interface/nav', { cookie: this.cookie(credentials) });
    if (result.code === -101) throw new BilibiliUpstreamError('login-expired');
    const data = biliRecord(result.data);
    if (result.code !== 0 || !data || data.isLogin !== true) throw new BilibiliUpstreamError(result.code === 0 ? 'login-expired' : 'upstream-blocked');
    if (String(data.mid) !== BILIBILI_UID) throw new BilibiliUpstreamError('wrong-account'); return data;
  }
  private async upstream<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      const reason = error instanceof BilibiliUpstreamError ? error.reason : 'invalid-response';
      throw new ApiError(`BILIBILI_${reason.toUpperCase().replaceAll('-', '_')}`, 502, reason === 'wrong-account' ? '请使用 UID 520237303 的B站账号扫码' : 'B站服务暂时不可用，请稍后重试');
    }
  }
  async pollQr(sessionId: string, transactionId: string): Promise<BilibiliQrPoll> {
    assert(/^[a-f0-9-]{36}$/u.test(transactionId), 'BILIBILI_QR_EXPIRED', 410, '二维码已失效，请重新获取');
    const scope = await sha256(sessionId), path = `bilibili_qr/${scope}`;
    const claim = await this.store.transaction(async tx => {
      const current = await tx.get<QrRecord>(path);
      if (!current || current.id !== transactionId || current.scope !== scope) return { state: 'expired' as const };
      if (current.expiresAt <= this.now()) { tx.delete(path); return { state: 'expired' as const }; }
      if (!current.encrypted) return { state: current.state };
      if (current.nextPollAt > this.now() || current.leaseUntil > this.now()) return { state: current.state };
      const next = { ...current, nextPollAt: this.now() + 2000, leaseUntil: this.now() + 15000, pollAttempt: crypto.randomUUID() }; tx.put(path, next); return { record: next };
    });
    if (!('record' in claim) || !claim.record) return { state: claim.state || 'waiting' };
    const current = claim.record;
    try {
      const decoded = biliRecord(await this.unseal(current.encrypted!, `bilibili:qr:v1:${scope}:${transactionId}`));
      assert(typeof decoded?.authCode === 'string', 'BILIBILI_QR_EXPIRED', 410, '二维码已失效，请重新获取');
      const result = await biliJson(this.fetcher, 'https://passport.bilibili.com/x/passport-tv-login/qrcode/poll', { form: tvForm(this.now(), { auth_code: decoded.authCode, local_id: '0' }) });
      if ([86039, 86090, 86038].includes(Number(result.code))) {
        const state = result.code === 86038 ? 'expired' : result.code === 86090 ? 'scanned' : 'waiting';
        await this.store.transaction(async tx => { const latest = await tx.get<QrRecord>(path); if (latest?.id === transactionId && latest.pollAttempt === current.pollAttempt) tx.put(path, { ...latest, state, leaseUntil: 0, pollAttempt: null, ...(state === 'expired' ? { encrypted: null } : {}) }); });
        return { state };
      }
      if (result.code !== 0) throw new BilibiliUpstreamError('upstream-blocked');
      const credentials = this.parseCredentials(result.data);
      await this.identity(credentials);
      const encrypted = await this.seal(credentials, credentialScope), linkedAt = this.now();
      const installed = await this.store.transaction(async tx => {
        const [qr, binding] = await Promise.all([tx.get<QrRecord>(path), tx.get<BindingRecord>(BINDING)]);
        if (!qr || qr.id !== transactionId || qr.pollAttempt !== current.pollAttempt || !qr.encrypted || qr.expiresAt <= this.now() || (binding?.revision || null) !== current.baseRevision) return false;
        tx.put(BINDING, { ...this.empty(), revision: crypto.randomUUID(), state: 'bound', encrypted, linkedAt, expiresAt: credentials.expiresAt });
        tx.put(path, { ...qr, encrypted: null, state: 'bound', leaseUntil: 0, pollAttempt: null }); return true;
      });
      if (!installed) return { state: 'expired' };
      return { state: 'bound', binding: await this.adminStatus() };
    } catch (error) {
      const rejected = error instanceof BilibiliUpstreamError && error.reason === 'wrong-account';
      await this.store.transaction(async tx => { const latest = await tx.get<QrRecord>(path); if (latest?.id === transactionId && latest.pollAttempt === current.pollAttempt) tx.put(path, { ...latest, leaseUntil: 0, pollAttempt: null, ...(rejected ? { encrypted: null, state: 'rejected' } : {}) }); });
      if (rejected) return { state: 'rejected' };
      return this.upstream(async () => { throw error; });
    }
  }
  private async refresh(credentials: Credentials): Promise<Credentials> {
    // TV uses its own platform key for refresh; no Android/web token conversion.
    const result = await biliJson(this.fetcher, 'https://passport.bilibili.com/x/passport-login/oauth2/refresh_token', { form: tvForm(this.now(), { access_key: credentials.accessToken, actionKey: 'appkey', refresh_token: credentials.refreshToken }) });
    if (result.code !== 0) throw new BilibiliUpstreamError([-101, -400, -663].includes(Number(result.code)) ? 'login-expired' : 'upstream-blocked');
    return this.parseCredentials(result.data);
  }
  private async persistRefreshed(claimed: BindingRecord, credentials: Credentials): Promise<void> {
    const encrypted = await this.seal(credentials, credentialScope);
    const saved = await this.store.transaction(async tx => {
      const current = await tx.get<BindingRecord>(BINDING);
      if (!current || current.revision !== claimed.revision || current.syncAttempt !== claimed.syncAttempt) return false;
      tx.put(BINDING, { ...current, encrypted, expiresAt: credentials.expiresAt }); return true;
    });
    assert(saved, 'BILIBILI_BINDING_CHANGED', 409, 'B站绑定状态已变化，请刷新');
  }
  private async works(nav: Record<string, unknown>, credentials: Credentials): Promise<BilibiliWork[]> {
    const query = publicWorksQuery(nav, BILIBILI_UID, this.now());
    const result = await biliJson(this.fetcher, `https://api.bilibili.com/x/space/wbi/arc/search?${query}`, { cookie: this.cookie(credentials) });
    const list = biliRecord(biliRecord(result.data)?.list)?.vlist;
    if (result.code !== 0 || !Array.isArray(list)) throw new BilibiliUpstreamError('upstream-blocked');
    if (!list.length) return [];
    const candidates = list.slice(0, 6).map(biliRecord).filter(item => item && /^BV[1-9A-HJ-NP-Za-km-z]{10}$/u.test(String(item.bvid)) && biliRecord(item.meta)?.attribute !== 156);
    if (!candidates.length) return [];
    const verified: BilibiliWork[] = []; let nonPublic = 0;
    // Verify visibility without the owner's cookies before publishing any work.
    for (let start = 0; start < candidates.length; start += 3) {
      const results = await Promise.allSettled(candidates.slice(start, start + 3).map(async item => {
        const value = await biliJson(this.fetcher, `https://api.bilibili.com/x/web-interface/view?bvid=${item!.bvid}`);
        const data = biliRecord(value.data), owner = biliRecord(data?.owner);
        if (value.code === -404 || (value.code === 0 && data && ((typeof data.state === 'number' && data.state !== 0) || (owner?.mid !== undefined && String(owner.mid) !== BILIBILI_UID)))) throw new NonPublicWork();
        if (value.code !== 0 || !data || data.state !== 0 || String(owner?.mid) !== BILIBILI_UID || data.bvid !== item!.bvid) throw new BilibiliUpstreamError('invalid-response');
        const picture = typeof data.pic === 'string' ? data.pic.replace(/^http:\/\//u, 'https://') : '';
        const published = biliCount(data.pubdate), title = biliText(data.title, 200);
        return BilibiliWorkSchema.parse({ bvid: data.bvid, title, url: `https://www.bilibili.com/video/${data.bvid}/`, coverUrl: isBilibiliCoverUrl(picture) ? picture : null, publishedAt: published && published * 1000 <= this.now() ? new Date(published * 1000).toISOString() : null, views: biliCount(biliRecord(data.stat)?.view), durationSeconds: biliCount(data.duration) });
      }));
      for (const result of results) { if (result.status === 'fulfilled') verified.push(result.value); else if (result.reason instanceof NonPublicWork) nonPublic++; }
    }
    if (!verified.length && !nonPublic) throw new BilibiliUpstreamError('invalid-response');
    // Never merge a removed/private work back from an earlier snapshot. Only a
    // total transient outage rejects this section and preserves the prior list.
    return verified;
  }
  async sync(force = true): Promise<BilibiliBindingStatus> {
    await this.cleanupQr();
    const claimed = await this.store.transaction(async tx => {
      const record = await tx.get<BindingRecord>(BINDING), now = this.now();
      if (!record?.encrypted || record.state === 'unbound' || record.leaseUntil > now || (!force && record.lastAttemptAt !== null && now - record.lastAttemptAt < 6 * HOUR)) return null;
      const next = { ...record, lastAttemptAt: now, leaseUntil: now + 120_000, syncAttempt: crypto.randomUUID() }; tx.put(BINDING, next); return next;
    });
    if (!claimed) return this.adminStatus();
    try {
      let credentials = credentialSchema.parse(await this.unseal(claimed.encrypted!, credentialScope));
      let renewed = false;
      if (credentials.expiresAt <= this.now() + 24 * HOUR) { credentials = await this.refresh(credentials); await this.persistRefreshed(claimed, credentials); renewed = true; }
      let nav: Record<string, unknown>;
      try { nav = await this.identity(credentials); }
      catch (error) { if (!(error instanceof BilibiliUpstreamError) || error.reason !== 'login-expired' || renewed) throw error; credentials = await this.refresh(credentials); await this.persistRefreshed(claimed, credentials); renewed = true; nav = await this.identity(credentials); }
      const previous = await this.publicData();
      const [profileResult, worksResult] = await Promise.allSettled([
        biliJson(this.fetcher, `https://api.bilibili.com/x/web-interface/card?mid=${BILIBILI_UID}`, { cookie: this.cookie(credentials) }).then(value => sanitizeBilibiliProfile(value, this.now())),
        this.works(nav, credentials),
      ]);
      const updatedAt = this.now(), profileOk = profileResult.status === 'fulfilled', worksOk = worksResult.status === 'fulfilled';
      const publicValue: BilibiliPublicData = { profile: profileOk ? profileResult.value : previous?.profile || BilibiliProfileSchema.parse(packagedSnapshot), works: worksOk ? worksResult.value : previous?.works || [], worksUpdatedAt: worksOk ? new Date(updatedAt).toISOString() : previous?.worksUpdatedAt || null };
      const encrypted = renewed ? await this.seal(credentials, credentialScope) : claimed.encrypted;
      await this.store.transaction(async tx => {
        const current = await tx.get<BindingRecord>(BINDING);
        if (!current || current.revision !== claimed.revision || current.syncAttempt !== claimed.syncAttempt) return;
        tx.put(BINDING, { ...current, state: 'bound', encrypted, expiresAt: credentials.expiresAt, lastSyncAt: profileOk || worksOk ? updatedAt : current.lastSyncAt, lastError: profileOk && worksOk ? null : profileOk || worksOk ? 'partial-sync' : 'upstream-unavailable', leaseUntil: 0, syncAttempt: null });
        if (profileOk || worksOk) tx.put(PUBLIC, publicValue);
      });
    } catch (error) {
      const reason = error instanceof BilibiliUpstreamError ? error.reason : error instanceof ApiError && error.code === 'BILIBILI_CREDENTIALS_UNAVAILABLE' ? 'credentials-unavailable' : 'invalid-response';
      await this.store.transaction(async tx => {
        const current = await tx.get<BindingRecord>(BINDING);
        if (current?.revision === claimed.revision && current.syncAttempt === claimed.syncAttempt) {
          const expired = ['login-expired', 'wrong-account', 'credentials-unavailable'].includes(reason) || (current.expiresAt !== null && current.expiresAt <= this.now());
          tx.put(BINDING, { ...current, state: expired ? 'expired' : current.state, lastError: reason, leaseUntil: 0, syncAttempt: null });
        }
      });
      console.warn(JSON.stringify({ level: 'warn', code: 'BILIBILI_SYNC_UNAVAILABLE', reason }));
    }
    return this.adminStatus();
  }
  async unlink(): Promise<BilibiliBindingStatus> {
    await this.store.transaction(async tx => {
      const [current, publicValue] = await Promise.all([tx.get<BindingRecord>(BINDING), tx.get<BilibiliPublicData>(PUBLIC)]);
      tx.put(BINDING, this.empty());
      if (publicValue) tx.put(PUBLIC, { ...publicValue, profile: { ...publicValue.profile, status: 'snapshot' } });
      // A new revision prevents an older QR poll or in-flight sync restoring credentials.
      void current;
    });
    return this.adminStatus();
  }
}
