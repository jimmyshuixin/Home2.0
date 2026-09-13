import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { cachePublishedSection, MAX_PUBLIC_SECTION_CACHE_BYTES, type PublishedSection } from '../src/public-data';
import { publicCacheKey, type PublicReadCache } from '../src/public-read-cache';
import { emptySnapshot, type Snapshot } from '../src/releases';

let mf: Miniflare, context: PublicReadCache, releaseId: string, snapshot: Snapshot;
let matches: number, writes: number;
beforeAll(async () => {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("section cache test"); } }', compatibilityDate: '2026-09-11' }), telemetry: { enabled: false }, cf: false });
});
beforeEach(async () => {
  releaseId = crypto.randomUUID(); snapshot = emptySnapshot(releaseId); matches = 0; writes = 0;
  const storage = await mf.getCaches(), cache = await storage.open(`data-${releaseId}`);
  context = { origin: 'https://data.invalid', cache: {
    // Materialize this <=1MiB test fixture when crossing the Node/workerd
    // bridge; real Cache API keying/storage still execute inside workerd.
    match: (async (...args: Parameters<Cache['match']>) => {
      matches++; const response = await cache.match(...args as Parameters<typeof cache.match>);
      return response && new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    }) as Cache['match'],
    put: (async (...args: Parameters<Cache['put']>) => { writes++; return cache.put(...args as unknown as Parameters<typeof cache.put>); }) as Cache['put'],
  } };
});
afterAll(async () => { await mf.dispose(); });

describe('published section cache', () => {
  it.each<PublishedSection>(['settings', 'playlists', 'creations', 'albums', 'fitness'])('loads %s once, caches only the section and returns detached values', async section => {
    const load = vi.fn(async () => snapshot);
    expect(await cachePublishedSection(context, releaseId, section, load)).toEqual(snapshot[section]);
    const cached = await cachePublishedSection(context, releaseId, section, load);
    expect(cached).toEqual(snapshot[section]); expect(load).toHaveBeenCalledTimes(1); expect(writes).toBe(1);
    const raw = await context.cache.match(publicCacheKey(context, releaseId, 'index', `published-section/${section}`));
    const text = await raw!.text(); expect(text).not.toContain('routeAliases'); expect(text).not.toContain('schemaVersion');
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_PUBLIC_SECTION_CACHE_BYTES);
    expect(cached).not.toBe(snapshot[section]);
  });

  it('isolates release changes without caching or selecting the active pointer', async () => {
    const first = vi.fn(async () => snapshot);
    await cachePublishedSection(context, releaseId, 'settings', first);
    const nextId = crypto.randomUUID(), next = emptySnapshot(nextId), loadNext = vi.fn(async () => next);
    next.settings.intro = 'Explicit next-release test text';
    expect(await cachePublishedSection(context, nextId, 'settings', loadNext)).toEqual(next.settings);
    expect(loadNext).toHaveBeenCalledTimes(1); expect(writes).toBe(2);
    expect(await cachePublishedSection(context, releaseId, 'settings', first)).toEqual(snapshot.settings);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache entirely for an undefined context such as private preview', async () => {
    await cachePublishedSection(context, releaseId, 'settings', async () => snapshot); matches = 0; writes = 0;
    const privateSnapshot = emptySnapshot('private-preview'), load = vi.fn(async () => privateSnapshot);
    privateSnapshot.settings.intro = 'Private test text';
    for (let i = 0; i < 2; i++) expect(await cachePublishedSection(undefined, releaseId, 'settings', load)).toEqual(privateSnapshot.settings);
    expect(load).toHaveBeenCalledTimes(2); expect(matches).toBe(0); expect(writes).toBe(0);
  });

  it('does not serialize or cache an oversized section and preserves its data', async () => {
    snapshot.settings.intro = '中'.repeat(MAX_PUBLIC_SECTION_CACHE_BYTES);
    const load = vi.fn(async () => snapshot);
    expect(await cachePublishedSection(context, releaseId, 'settings', load)).toBe(snapshot.settings);
    expect(await cachePublishedSection(context, releaseId, 'settings', load)).toBe(snapshot.settings);
    expect(writes).toBe(0); expect(load).toHaveBeenCalledTimes(2);
  });

  it('counts UTF-8 and escaped JSON bytes rather than character count', async () => {
    snapshot.settings.intro = '\u0000'.repeat(200000);
    expect(await cachePublishedSection(context, releaseId, 'settings', async () => snapshot)).toBe(snapshot.settings);
    expect(writes).toBe(0);
    snapshot.settings.intro = '中'.repeat(100000);
    const load = vi.fn(async () => snapshot);
    await cachePublishedSection(context, releaseId, 'settings', load);
    expect(await cachePublishedSection(context, releaseId, 'settings', load)).toEqual(snapshot.settings);
    expect(writes).toBe(1); expect(load).toHaveBeenCalledTimes(1);
  });

  it('fails open on cache I/O and malformed cache data, while preserving loader errors', async () => {
    const broken: PublicReadCache = { ...context, cache: { match: vi.fn(async () => { throw new Error('cache outage'); }), put: vi.fn(async () => { throw new Error('cache outage'); }) } };
    expect(await cachePublishedSection(broken, releaseId, 'fitness', async () => snapshot)).toEqual(snapshot.fitness);
    const key = publicCacheKey(context, releaseId, 'index', 'published-section/settings');
    await context.cache.put(key, new Response('{bad json', { headers: { 'cache-control': 'public, max-age=600', 'x-xvyin-section-bytes': '9' } }));
    const load = vi.fn(async () => snapshot);
    expect(await cachePublishedSection(context, releaseId, 'settings', load)).toEqual(snapshot.settings); expect(load).toHaveBeenCalledTimes(1);
    await expect(cachePublishedSection(broken, releaseId, 'fitness', async () => { throw new Error('snapshot unavailable'); })).rejects.toThrow('snapshot unavailable');
  });

  it('rejects a loader release mismatch without storing or exposing that section', async () => {
    await expect(cachePublishedSection(context, releaseId, 'settings', async () => emptySnapshot('private-preview'))).rejects.toMatchObject({ code: 'RELEASE_INTEGRITY' });
    expect(writes).toBe(0);
  });

  it('tracks section writes with waitUntil when an execution context is supplied', async () => {
    const tasks: Promise<unknown>[] = [], load = vi.fn(async () => snapshot);
    await cachePublishedSection({ ...context, waitUntil: task => { tasks.push(task); } }, releaseId, 'fitness', load);
    expect(tasks).toHaveLength(1); await Promise.all(tasks);
    expect(await cachePublishedSection(context, releaseId, 'fitness', load)).toEqual(snapshot.fitness); expect(load).toHaveBeenCalledTimes(1);
  });
});
