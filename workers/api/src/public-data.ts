import type { Snapshot } from './releases';
import { assert } from './errors';
import { cacheRead, cacheWrite, internalCacheHeaders, publicCacheKey, type PublicReadCache } from './public-read-cache';

export type PublishedSection = 'settings' | 'playlists' | 'creations' | 'albums' | 'fitness';
export const MAX_PUBLIC_SECTION_CACHE_BYTES = 1024 * 1024;
const sections = new Set<PublishedSection>(['settings', 'playlists', 'creations', 'albums', 'fitness']);

function serializedSection(value: unknown): string | null {
  // Stop before serializing a huge string/collection. Counting each escaped
  // token bounds temporary work too; oversized data still returns uncached.
  const encoder = new TextEncoder(), exceeded = Symbol('section cache size');
  let remaining = MAX_PUBLIC_SECTION_CACHE_BYTES;
  const count = (value: string) => {
    if (value.length > remaining) throw exceeded;
    remaining -= encoder.encode(JSON.stringify(value)).byteLength;
    if (remaining < 0) throw exceeded;
  };
  try {
    const json = JSON.stringify(value, (key, item: unknown) => {
      count(key); remaining -= 2;
      if (typeof item === 'string') count(item);
      else remaining -= typeof item === 'number' ? String(item).length : 5;
      if (remaining < 0) throw exceeded;
      return item;
    });
    return json !== undefined && encoder.encode(json).byteLength <= MAX_PUBLIC_SECTION_CACHE_BYTES ? json : null;
  } catch { return null; }
}

async function cachedSection(response: Response): Promise<{ value: unknown } | null> {
  const declared = response.headers.get('x-xvyin-section-bytes'), size = Number(declared);
  if (response.status !== 200 || declared === null || !Number.isSafeInteger(size) || size < 1 || size > MAX_PUBLIC_SECTION_CACHE_BYTES || !response.body) {
    await response.body?.cancel().catch(() => {}); return null;
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let received = 0, text = '';
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > size || received > MAX_PUBLIC_SECTION_CACHE_BYTES) { await reader.cancel(); return null; }
      text += decoder.decode(chunk.value, { stream: true });
    }
    if (received !== size) return null;
    return { value: JSON.parse(text + decoder.decode()) as unknown };
  } catch { await reader.cancel().catch(() => {}); return null; }
  finally { reader.releaseLock(); }
}

/** The caller must freshly resolve active-release.json before EACH call.
 * Pass no context for private previews; neither preview sessions nor the active
 * pointer are cached here. Each value belongs to one immutable public release. */
export async function cachePublishedSection<K extends PublishedSection>(context: PublicReadCache | undefined, releaseId: string, section: K, loadSnapshot: () => Promise<Snapshot>): Promise<Snapshot[K]> {
  if (!sections.has(section)) throw new TypeError('Unknown published section');
  if (!context) return (await loadSnapshot())[section];
  const key = publicCacheKey(context, releaseId, 'index', `published-section/${section}`);
  const response = await cacheRead(context, key);
  if (response) {
    const hit = await cachedSection(response);
    if (hit) return hit.value as Snapshot[K];
  }
  const snapshot = await loadSnapshot(), value = snapshot[section];
  // A mismatched loader may be a preview. Never return or cache it as public.
  assert(snapshot.releaseId === releaseId, 'RELEASE_INTEGRITY', 503, '公开内容版本不一致，请刷新后重试');
  const json = serializedSection(value);
  if (json !== null) {
    const bytes = new TextEncoder().encode(json).byteLength;
    await cacheWrite(context, key, new Response(json, { headers: internalCacheHeaders({ 'content-type': 'application/json; charset=utf-8', 'content-length': String(bytes), 'x-xvyin-section-bytes': String(bytes) }) }));
  }
  return value;
}
