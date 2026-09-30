import { SEARCH_CATEGORIES, SEARCH_PAGE_SIZE, SEARCH_QUERY_LIMIT, searchBundlePath, searchExcerpt, searchResultPath, type SearchCategory, type SearchExcerptPart } from './search-shared'

export interface SearchResult { url: string; title: string; category: SearchCategory; excerpt: SearchExcerptPart[]; publishedAt: string }
export interface SearchPage { results: SearchResult[]; total: number; offset: number }
interface PagefindResult { data(): Promise<unknown> }
export interface PagefindModule {
  options(options: { basePath: string; baseUrl: string; excerptLength: number; metaCacheTag: string; noWorker: true }): Promise<unknown>
  search(query: string, options?: { filters?: { category: SearchCategory } }): Promise<{ results: PagefindResult[] }>
  destroy?(): Promise<unknown>
}
export class SearchUnavailable extends Error {
  constructor(readonly reason: 'unavailable' | 'version-unavailable' | 'invalid-index' = 'unavailable') { super(reason) }
}
export interface SearchClientOptions {
  loadModule?: (url: string) => Promise<PagefindModule>
  fetcher?: typeof fetch
  timeoutMs?: number
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
function deadline<T>(pending: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SearchUnavailable()), milliseconds) })])
    .finally(() => clearTimeout(timer))
}
async function checkRelease(fetcher: typeof fetch, path: string, releaseId: string, timeoutMs: number): Promise<void> {
  const response = await fetcher(`${path}xvyin-search.json`, { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  if (response.status === 404) { await response.body?.cancel(); throw new SearchUnavailable('version-unavailable') }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new SearchUnavailable() }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0, text = ''
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > 512 * 1024) throw new SearchUnavailable('invalid-index')
      text += decoder.decode(item.value, { stream: true })
    }
    const marker = object(JSON.parse(text + decoder.decode()))
    if (marker?.schemaVersion !== 1 || marker.releaseId !== releaseId || typeof marker.documentCount !== 'number' || !Number.isSafeInteger(marker.documentCount) || marker.documentCount < 0 || marker.documentCount > 2000) throw new SearchUnavailable('invalid-index')
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
}
function resultData(input: unknown): SearchResult {
  const data = object(input), meta = object(data?.meta), url = searchResultPath(data?.url)
  const category = meta?.category
  if (!url || !meta || typeof meta.title !== 'string' || !meta.title.trim() || meta.title.length > 240
    || typeof category !== 'string' || !Object.hasOwn(SEARCH_CATEGORIES, category)) throw new SearchUnavailable('invalid-index')
  const publishedAt = typeof meta.publishedAt === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(meta.publishedAt) ? meta.publishedAt : ''
  return { url, title: meta.title, category: category as SearchCategory, excerpt: searchExcerpt(data?.excerpt), publishedAt }
}

/** No bundle or index is fetched until a nonempty search is submitted. */
export function createSearchClient(releaseId: string, options: SearchClientOptions = {}) {
  const path = searchBundlePath(releaseId), timeoutMs = options.timeoutMs ?? 15000
  const fetcher = options.fetcher ?? fetch
  const loadModule = options.loadModule ?? ((url: string) => import(/* @vite-ignore */ url) as Promise<PagefindModule>)
  let instance: Promise<PagefindModule> | undefined, loaded: PagefindModule | undefined
  let loadAttempt = 0
  let epoch = 0
  let currentQuery = '', currentResults: Promise<{ results: PagefindResult[] }> | undefined
  function load() {
    if (!instance) {
      const attempt = ++loadAttempt
      const generation = epoch
      const pending = deadline((async () => {
        await checkRelease(fetcher, path, releaseId, timeoutMs)
        if (generation !== epoch) throw new SearchUnavailable()
        // A new URL on explicit retry avoids the browser caching a failed import.
        const module = await loadModule(`${path}pagefind.js?load=${attempt}`)
        await module.options({ basePath: path, baseUrl: '/', excerptLength: 26, metaCacheTag: releaseId, noWorker: true })
        if (generation !== epoch) throw new SearchUnavailable()
        loaded = module
        return module
      })(), timeoutMs)
      instance = pending
      pending.catch(() => { if (instance === pending) instance = undefined })
    }
    return instance
  }
  return {
    async search(query: string, category?: SearchCategory, offset = 0): Promise<SearchPage> {
      const term = query.trim()
      if (!term) return { results: [], total: 0, offset: 0 }
      if (Array.from(term).length > SEARCH_QUERY_LIMIT || !Number.isSafeInteger(offset) || offset < 0 || offset > 2000
        || category !== undefined && !Object.hasOwn(SEARCH_CATEGORIES, category)) throw new SearchUnavailable('invalid-index')
      const key = JSON.stringify([term, category])
      const generation = epoch
      try {
        const module = await load()
        if (generation !== epoch) throw new SearchUnavailable()
        if (key !== currentQuery || !currentResults) {
          currentQuery = key
          currentResults = deadline(module.search(term, category ? { filters: { category } } : undefined), timeoutMs)
        }
        const found = await currentResults
        if (generation !== epoch) throw new SearchUnavailable()
        if (!Array.isArray(found.results) || found.results.length > 2000) throw new SearchUnavailable('invalid-index')
        const results = await deadline(Promise.all(found.results.slice(offset, offset + SEARCH_PAGE_SIZE).map(async result => resultData(await result.data()))), timeoutMs)
        return { results, total: found.results.length, offset }
      } catch (error) {
        if (currentQuery === key && generation === epoch) currentResults = undefined
        throw error instanceof SearchUnavailable ? error : new SearchUnavailable()
      }
    },
    async reset() {
      epoch++
      currentQuery = ''; currentResults = undefined; instance = undefined
      const previous = loaded; loaded = undefined
      if (previous?.destroy) await deadline(previous.destroy(), 1000).catch(() => {})
    },
  }
}
