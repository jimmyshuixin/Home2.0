import { md5 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { BilibiliFetch } from './bilibili';

// BiliTV protocol constants, not the site's credential encryption secret.
// Source: biliup/biliup crates/biliup/src/uploader/credential.rs (2026-09-26).
const APP_KEY = '4409e2ce8ffd12b8', APP_SIGNING_CONSTANT = '59b43e04ad6965f34319062b478f83dd';
export type BilibiliFailure = 'timeout' | 'network' | 'upstream-blocked' | 'invalid-response' | 'login-expired' | 'wrong-account';
export class BilibiliUpstreamError extends Error { constructor(readonly reason: BilibiliFailure) { super(reason); } }
export const biliRecord = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const biliText = (value: unknown, max: number): string | null => typeof value === 'string' ? Array.from(value.replace(/<[^>]*>/gu, '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim()).slice(0, max).join('') : null;
export const biliCount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const hash = (value: string) => bytesToHex(md5(new TextEncoder().encode(value)));
export function tvForm(now: number, values: Record<string, string> = {}): URLSearchParams {
  const fields = { appkey: APP_KEY, ts: String(Math.floor(now / 1000)), ...values };
  const form = new URLSearchParams(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)));
  form.set('sign', hash(form.toString() + APP_SIGNING_CONSTANT)); return form;
}

/** WBI signing matches yt-dlp's current primary Bilibili extractor. No key URL is fetched. */
export function publicWorksQuery(nav: Record<string, unknown>, uid: string, now: number): string {
  const images = biliRecord(nav.wbi_img);
  const key = (value: unknown) => {
    if (typeof value !== 'string') throw new BilibiliUpstreamError('invalid-response');
    const match = /\/([a-f0-9]{32})\.(?:png|jpg)$/u.exec(value);
    if (!match) throw new BilibiliUpstreamError('invalid-response'); return match[1]!;
  };
  const raw = key(images?.img_url) + key(images?.sub_url);
  const order = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13];
  const mixed = order.map(index => raw[index]).join('');
  const fields = { mid: uid, order: 'pubdate', order_avoided: 'true', platform: 'web', pn: '1', ps: '6', tid: '0', web_location: '333.1387', wts: String(Math.floor(now / 1000)) };
  const query = new URLSearchParams(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))).toString();
  return `${query}&w_rid=${hash(query + mixed)}`;
}

export async function biliJson(fetcher: BilibiliFetch, url: string, options: { form?: URLSearchParams; cookie?: string } = {}): Promise<Record<string, unknown>> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !['passport.bilibili.com', 'api.bilibili.com'].includes(target.hostname) || target.username || target.password || target.port) throw new BilibiliUpstreamError('invalid-response');
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BilibiliUpstreamError('timeout')); }, 5000); });
  try {
    return await Promise.race([deadline, (async () => {
      const headers = new Headers({ accept: 'application/json', referer: 'https://www.bilibili.com/' });
      if (options.cookie) headers.set('cookie', options.cookie);
      if (options.form) headers.set('content-type', 'application/x-www-form-urlencoded');
      const response = await fetcher(new Request(target, { method: options.form ? 'POST' : 'GET', headers, body: options.form?.toString(), redirect: 'manual', signal: controller.signal }));
      if (response.status !== 200 || !response.body || Number(response.headers.get('content-length') || 0) > 256 * 1024) { await response.body?.cancel().catch(() => {}); throw new BilibiliUpstreamError('upstream-blocked'); }
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0, text = '';
      const cancel = () => { void reader.cancel().catch(() => {}); }; controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        for (;;) { if (controller.signal.aborted) throw new BilibiliUpstreamError('timeout'); const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 256 * 1024) throw new BilibiliUpstreamError('invalid-response'); text += decoder.decode(chunk.value, { stream: true }); }
        const value = biliRecord(JSON.parse(text + decoder.decode())); if (!value || typeof value.code !== 'number') throw new BilibiliUpstreamError('invalid-response'); return value;
      } catch (error) { await reader.cancel().catch(() => {}); throw error instanceof BilibiliUpstreamError ? error : new BilibiliUpstreamError('invalid-response'); }
      finally { controller.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
    })()]);
  } catch (error) { throw error instanceof BilibiliUpstreamError ? error : new BilibiliUpstreamError(controller.signal.aborted ? 'timeout' : 'network'); }
  finally { clearTimeout(timer); controller.abort(); }
}
