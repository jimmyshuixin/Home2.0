import { describe, expect, it, vi } from 'vitest'
import { createSearchClient, type PagefindModule } from '../lib/search-client'
import { searchBundlePath, searchExcerpt, searchResultPath } from '../lib/search-shared'

const releaseId = 'search-release-one'
const marker = () => new Response(JSON.stringify({ schemaVersion: 1, releaseId, documentCount: 12 }))
const record = (index: number) => ({ url: `/creations/notes-${index}`, meta: { title: `记录 ${index}`, category: 'creation', publishedAt: '2026-09-30T00:00:00Z' }, excerpt: '江边的<mark>芦苇</mark>。' })
function moduleFixture(count = 12) {
  const getData = vi.fn(async (index: number) => record(index))
  const module: PagefindModule = {
    options: vi.fn(async () => {}), destroy: vi.fn(async () => {}),
    search: vi.fn(async () => ({ results: Array.from({ length: count }, (_, index) => ({ data: () => getData(index) })) })),
  }
  return { module, getData }
}

describe('lazy release-scoped search client', () => {
  it('does no I/O until a nonempty query and only resolves the displayed result page', async () => {
    const { module, getData } = moduleFixture(), fetcher = vi.fn(async () => marker()), loadModule = vi.fn(async () => module)
    const client = createSearchClient(releaseId, { fetcher, loadModule })
    expect(await client.search('   ')).toEqual({ results: [], total: 0, offset: 0 })
    expect(fetcher).not.toHaveBeenCalled(); expect(loadModule).not.toHaveBeenCalled()
    const first = await client.search('芦苇')
    expect(first.total).toBe(12); expect(first.results).toHaveLength(8)
    expect(getData).toHaveBeenCalledTimes(8)
    expect(loadModule).toHaveBeenCalledWith('/search-index/search-release-one/pagefind.js?load=1')
    expect(module.options).toHaveBeenCalledWith(expect.objectContaining({ basePath: '/search-index/search-release-one/', metaCacheTag: releaseId, noWorker: true }))
    const next = await client.search('芦苇', undefined, 8)
    expect(next.results).toHaveLength(4); expect(module.search).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await client.search('芦苇', 'photography')
    expect(module.search).toHaveBeenLastCalledWith('芦苇', { filters: { category: 'photography' } })
  })

  it('never imports a missing or mismatched release index', async () => {
    for (const response of [new Response('', { status: 404 }), new Response(JSON.stringify({ schemaVersion: 1, releaseId: 'other', documentCount: 1 }))]) {
      const loadModule = vi.fn(), client = createSearchClient(releaseId, { fetcher: async () => response, loadModule })
      await expect(client.search('文字')).rejects.toThrow()
      expect(loadModule).not.toHaveBeenCalled()
    }
  })

  it('can explicitly retry a transient import failure without reusing the failed import URL', async () => {
    const { module } = moduleFixture(1)
    const loadModule = vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValue(module)
    const client = createSearchClient(releaseId, { fetcher: async () => marker(), loadModule })
    await expect(client.search('文字')).rejects.toThrow('unavailable')
    await client.reset()
    expect((await client.search('文字')).results).toHaveLength(1)
    expect(loadModule.mock.calls.map(call => call[0])).toEqual(['/search-index/search-release-one/pagefind.js?load=1', '/search-index/search-release-one/pagefind.js?load=2'])
  })

  it('bounds manifest size, query length, offsets and stalled initialization', async () => {
    const loadModule = vi.fn(), oversized = new Response('x'.repeat(512 * 1024 + 1))
    const client = createSearchClient(releaseId, { fetcher: async () => oversized, loadModule })
    await expect(client.search('文字')).rejects.toThrow('invalid-index')
    await expect(client.search('字'.repeat(101))).rejects.toThrow('invalid-index')
    await expect(client.search('字', undefined, -1)).rejects.toThrow('invalid-index')
    expect(loadModule).not.toHaveBeenCalled()
    const stalled = createSearchClient(releaseId, { fetcher: async () => marker(), loadModule: () => new Promise(() => {}), timeoutMs: 10 })
    await expect(stalled.search('字')).rejects.toThrow('unavailable')
  })

  it('rejects external/admin URLs and unknown categories from the result layer', async () => {
    for (const invalid of [
      { ...record(1), url: 'https://example.com/private' }, { ...record(1), url: '/admin' },
      { ...record(1), url: '/creations/../about' }, { ...record(1), meta: { title: '标题', category: '__proto__' } },
    ]) {
      const module: PagefindModule = { options: async () => {}, search: async () => ({ results: [{ data: async () => invalid }] }) }
      const client = createSearchClient(releaseId, { fetcher: async () => marker(), loadModule: async () => module })
      await expect(client.search('字')).rejects.toThrow('invalid-index')
    }
  })

  it('does not let an old failed query erase a newer pending query', async () => {
    let rejectOld!: (error: Error) => void
    const { module } = moduleFixture(1)
    const search = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject })).mockResolvedValue({ results: [{ data: async () => record(2) }] })
    module.search = search
    const client = createSearchClient(releaseId, { fetcher: async () => marker(), loadModule: async () => module })
    const old = client.search('旧词').catch(() => null)
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    expect((await client.search('新词')).results[0]?.url).toBe('/creations/notes-2')
    rejectOld(new Error('old request failed')); await old
    await client.search('新词')
    expect(search).toHaveBeenCalledTimes(2)
  })
})

describe('safe result presentation', () => {
  it('only produces release-scoped bundle paths and supported local result URLs', () => {
    expect(searchBundlePath('release-one')).toBe('/search-index/release-one/')
    for (const value of ['../private', 'a/b', 'a?b', '']) expect(() => searchBundlePath(value)).toThrow()
    expect(searchResultPath('/photography/mountains/')).toBe('/photography/mountains')
    for (const value of ['//evil.example', '/api/v1/private', '/creations/a?token=x', '/about#x', 'javascript:alert(1)']) expect(searchResultPath(value)).toBeNull()
  })

  it('converts snippets into inert text/mark parts without HTML injection', () => {
    const parts = searchExcerpt('青山 <img src=x onerror=alert(1)><mark>云海</mark> &lt;script&gt;文字&lt;/script&gt; &#x1f324; 芦苇\u200b荡')
    expect(parts).toEqual([
      { text: '青山 ', highlighted: false }, { text: '云海', highlighted: true },
      { text: ' <script>文字</script> 🌤 芦苇荡', highlighted: false },
    ])
    expect(parts.map(part => part.text).join('')).not.toContain('onerror')
    expect(searchExcerpt('&#x110000; &#55296;')).toEqual([{ text: ' ', highlighted: false }])
  })
})
