import { describe, expect, it } from 'vitest'
import sax from 'sax'
import { publicSnapshot } from '../lib/build-snapshot'
import { absolutePublicUrl, albumImageIds, creationImageIds, publicationFeeds, sharingImage, xmlText } from '../lib/publication-metadata'
import { buildContentType } from '../../../scripts/v3/publish'

const origin = 'https://xvyin.com'
function fixture() {
  return publicSnapshot({ schemaVersion: 1, releaseId: 'test-release', settings: { siteTitle: '虚宁 & 阅读' },
    creations: [{ id: 'creation-a', revisionId: 'revision-a', publishedAt: '2026-09-29T00:00:00.000Z', title: '第一篇 & 日记', slug: 'first', summary: '摘录', formats: ['text'], blocks: [{ id: 'body', type: 'richtext', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '中文正文与 ' }, { type: 'text', text: '强调', marks: [{ type: 'bold' }] }, { type: 'hardBreak' }, { type: 'text', text: '第二行' }] }] } }] }],
    albums: [{ id: 'album-a', revisionId: 'revision-b', publishedAt: '2026-09-30T00:00:00.000Z', title: '光影', slug: 'light', photos: [{ id: 'photo-a', assetId: 'asset-a', alt: '窗边光影', caption: '一束光', status: 'published', location: { precision: 'city', latitude: 30, longitude: 120, label: '城市' } }] }],
    fitness: { settings: {}, entries: [] }, playlists: [], assets: [{ id: 'asset-a', kind: 'image', variants: [{ role: 'download', url: '/original.jpg', mime: 'image/jpeg', bytes: 100 }, { role: 'content', url: '/display.webp', mime: 'image/webp', bytes: 60, width: 1200, height: 800 }] }], routeAliases: {} })
}
describe('published feeds and sharing metadata', () => {
  it('renders valid escaped RSS and JSON Feed with stable IDs, real timestamps and full text', () => {
    const site = fixture(), { json, rss } = publicationFeeds(site, origin)
    const parser = sax.parser(true), titles: string[] = []
    parser.onopentag = node => { titles.push(node.name) }
    expect(() => parser.write(rss).close()).not.toThrow()
    expect(titles.filter(tag => tag === 'item')).toHaveLength(2)
    expect(json.version).toBe('https://jsonfeed.org/version/1.1')
    expect(json.items.map(item => item.id)).toEqual(['urn:xvyin:album:album-a', 'urn:xvyin:creation:creation-a'])
    expect(json.items[1]?.content_text).toBe('中文正文与 强调\n第二行')
    expect(rss).toContain('第一篇 &amp; 日记')
    site.releaseId = 'next-release'; site.creations[0]!.slug = 'new-slug'
    expect(publicationFeeds(site, origin).json.items[1]?.id).toBe(json.items[1]?.id)
  })
  it('does not serialize asset fields, EXIF, coordinates, aliases or unpublished photos', () => {
    const site = fixture()
    site.albums[0]!.photos.push({ id: 'hidden', assetId: 'hidden', alt: 'PRIVATE_CANARY', status: 'hidden', sortOrder: 1, caption: '', photoDate: null, featured: false })
    const output = JSON.stringify(publicationFeeds(site, origin))
    for (const value of ['PRIVATE_CANARY', 'latitude', 'longitude', 'asset-a', 'original.jpg', 'display.webp', 'variants']) expect(output).not.toContain(value)
  })
  it('uses published display images and omits unavailable dimensions rather than inventing them', () => {
    const site = fixture()
    expect(sharingImage(site.assets, albumImageIds(site.albums[0]!), origin)).toEqual({ url: `${origin}/display.webp`, width: 1200, height: 800, type: 'image/webp' })
    expect(sharingImage(site.assets, creationImageIds(site.creations[0]!), origin).url).toBe(`${origin}/brand/ink-home.webp`)
    site.assets[0]!.variants = site.assets[0]!.variants.filter(item => item.role === 'download')
    expect(sharingImage(site.assets, ['asset-a'], origin).url).not.toContain('original')
  })
  it('keeps URL and XML boundaries safe for feeds and social crawlers', () => {
    for (const url of ['javascript:alert(1)', '//evil.invalid/a', 'https://user:pass@host/a', '/a\\b', '#local']) expect(absolutePublicUrl(url, origin)).toBeUndefined()
    expect(xmlText('a\u0000<&\"\'')).toBe('a&lt;&amp;&quot;&apos;')
    expect(buildContentType('/feed.xml')).toBe('application/rss+xml; charset=utf-8')
    expect(buildContentType('/feed.json')).toBe('application/feed+json; charset=utf-8')
    expect(buildContentType('/search-index/release/pagefind.wasm')).toBe('application/wasm')
  })
  it('caps feeds at 100 recent publications and supports an empty public site', () => {
    const site = fixture()
    site.albums = []
    site.creations = Array.from({ length: 110 }, (_, i) => ({ ...site.creations[0]!, id: `entry-${i}`, slug: `entry-${i}` }))
    expect(publicationFeeds(site, origin).json.items).toHaveLength(100)
    expect(publicationFeeds(publicSnapshot(), origin).json.items).toEqual([])
  })
})
