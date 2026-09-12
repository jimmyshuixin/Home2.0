import type { Store } from './store/types';
import { ApiError, assert } from './errors';
export const utf8 = new TextEncoder();
export function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export async function sha256(value: string | Uint8Array): Promise<string> {
  const buffer = typeof value === 'string' ? utf8.encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(buffer)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function secretEqual(a: string, b: string): Promise<boolean> {
  // HMAC verification delegates the secret comparison to Web Crypto.
  const key = await crypto.subtle.importKey('raw', utf8.encode('xvyin-csrf-comparison'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, utf8.encode(a));
  return crypto.subtle.verify('HMAC', key, signature, utf8.encode(b));
}
export async function boundedJson(request: Request, maxBytes = 280_000): Promise<unknown> {
  assert(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'UNSUPPORTED_MEDIA_TYPE', 415, '请求需要 JSON 格式');
  const length = request.headers.get('content-length');
  assert(!length || Number(length) <= maxBytes, 'BODY_TOO_LARGE', 413, '请求内容过大');
  const reader = request.body?.getReader();
  assert(reader, 'INVALID_JSON', 400, '请求内容为空');
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new ApiError('BODY_TOO_LARGE', 413, '请求内容过大'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); }
  catch { throw new ApiError('INVALID_JSON', 400, 'JSON 内容无效'); }
}
export function assertOrigin(request: Request, allowedOrigins: readonly string[]): void {
  const origin = request.headers.get('origin');
  assert(origin && allowedOrigins.includes(origin), 'ORIGIN_REJECTED', 403, '请求来源未获允许');
  assert(request.headers.get('sec-fetch-site') !== 'cross-site', 'ORIGIN_REJECTED', 403, '请求来源未获允许');
}
export function cookieValue(request: Request, name: string): string | null {
  const pairs = (request.headers.get('cookie') || '').split(';').map(v => v.trim().split('='));
  const values = pairs.filter(v => v[0] === name);
  return values.length === 1 ? values[0]?.[1] || null : null;
}
export async function rateLimit(store: Store, scope: string, key: string, limit: number, windowMs: number, now: number, salt: string): Promise<void> {
  assert(salt.length >= 32, 'SERVICE_NOT_CONFIGURED', 503, '访问保护尚未配置');
  const digest = await sha256(`${salt}:${scope}:${key}:${Math.floor(now / windowMs)}`);
  await store.transaction(async tx => {
    const previous = await tx.get<{ count: number }>(`rates/${digest}`);
    assert((previous?.count || 0) < limit, 'RATE_LIMITED', 429, '操作过于频繁，请稍后重试');
    tx.put(`rates/${digest}`, { count: (previous?.count || 0) + 1, expiresAt: now + windowMs * 2 });
  });
}
