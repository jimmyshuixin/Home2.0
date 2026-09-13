import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AlbumDraftSchema, CreationDraftSchema, FitnessSettingsDraftSchema, PlaylistDraftSchema, SiteSettingsSchema } from '@xvyin/contracts'
import { AssetMappingSchema, buildLegacyMigration, convertLegacyAbout, extractSiteDefaults, parseLegacyMarkdown, type MigrationManifest } from '../migrate-legacy'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
let manifest: MigrationManifest
beforeAll(async () => { manifest = await buildLegacyMigration(root) })

describe('real checked-in legacy content, no network or output writes', () => {
  it('inventories actual content, deduplicates fallback tracks, and refuses to substitute missing media', () => {
    expect(manifest.counts).toMatchObject({ candidates: 7, readyDrafts: 2, blockedCandidates: 5, articles: 1, localPlaylists: 2,
      uniqueLocalAudio: 6, localTrackReferences: 6, fallbackTrackReferences: 3, matchedFallbackPlaylists: 1,
      referencedPhotography: 1, unclassifiedPhotos: 3, requiredMediaSources: 15 })
    expect(manifest.aliases[0]!.equivalentTo).toEqual(['content/music/Animenz.json'])
    expect(manifest.audit.publicContentExists).toBe(false)
    expect(manifest.audit.originalsUnchanged).toBe(true)
    for (const item of manifest.candidates.filter(item => item.state === 'blocked')) {
      expect(item.draft).toBeNull(); expect(item.blockers.length).toBeGreaterThan(0)
    }
    expect(manifest.media.filter(item => item.local).every(item => item.sha256?.length === 64 && item.bytes! > 0)).toBe(true)
  })

  it('keeps fitness date null despite the old literal, and preserves the explicit article date only as provenance', () => {
    const fitness = manifest.candidates.find(item => item.target === 'fitnessSettings')!
    expect(FitnessSettingsDraftSchema.parse(fitness.draft).startDate).toBeNull()
    const article = manifest.candidates.find(item => item.target === 'creation')!
    expect(article.sourceDate).toEqual({ value: '2025-06-15', source: 'content/blog/manifest.json', pointer: '/0/date' })
    for (const item of manifest.candidates) {
      expect(item).not.toHaveProperty('publishedAt')
      if (item.draft) expect(item.draft).not.toHaveProperty('publishedAt')
    }
  })

  it('constructs all seven strict drafts only with explicit test-only mappings and retains titles, photo state, links and image block', async () => {
    const fetcher = vi.fn(() => { throw new Error('Migration must never fetch') })
    vi.stubGlobal('fetch', fetcher)
    try {
      // Unit-test identities only, kept in memory. Never exported into a migration/seed file.
      const mapped = await buildLegacyMigration(root, { schemaVersion: 1, assets: manifest.media.map((item, index) => ({
        source: item.source, kind: item.kind, sourceSha256: item.sha256 ?? 'a'.repeat(64), assetId: `test-only-asset-${index}`,
      })) })
      expect(mapped.counts).toMatchObject({ readyDrafts: 7, blockedCandidates: 0 })
      const site = SiteSettingsSchema.parse(mapped.candidates.find(item => item.target === 'siteSettings')!.draft)
      expect(site.heroTitle).toBe('Hello! I am 虚宁')
      expect(site.intro).toBe('路漫漫其修远兮，吾将上下而求索。')
      expect(JSON.stringify(site.about)).toContain('你好！屏幕前的你。')
      expect(JSON.stringify(site.about)).toContain('https://www.bilibili.com/video/BV1Kj411g7Lu')
      expect(JSON.stringify(site.about)).toContain('May you,the beauty of this world,always shine.')
      expect(JSON.stringify(site.about)).not.toContain('style=')
      const article = CreationDraftSchema.parse(mapped.candidates.find(item => item.target === 'creation')!.draft)
      expect(article.title).toBe('我的个人旅'); expect(article.slug).toBe('mylife')
      expect(article.blocks.map(block => block.type)).toEqual(['richtext', 'image'])
      expect(JSON.stringify(article.blocks[0])).toContain('往前看便好')
      expect(article).not.toHaveProperty('publishedAt'); expect(article).not.toHaveProperty('date')
      const album = AlbumDraftSchema.parse(mapped.candidates.find(item => item.target === 'album')!.draft)
      expect(album.title).toBe('光隅'); expect(album.photos[0]).toMatchObject({ photoDate: null, status: 'draft', alt: '暖色灯光摄影作品' })
      const playlists = mapped.candidates.filter(item => item.target === 'playlist').map(item => PlaylistDraftSchema.parse(item.draft))
      expect(playlists.find(item => item.isDefault)).toMatchObject({ source: 'tencent', sourceId: '9206816111', tracks: [] })
      expect(playlists.filter(item => item.source === 'local').map(item => item.tracks.length)).toEqual([3, 3])
      expect(fetcher).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('fails closed when an explicit mapping has the wrong original hash or kind', async () => {
    const original = manifest.media.find(item => item.local && item.kind === 'audio')!
    await expect(buildLegacyMigration(root, { schemaVersion: 1, assets: [{ source: original.source, kind: 'audio', sourceSha256: '0'.repeat(64), assetId: 'test-only' }] })).rejects.toThrow('Mapped source hash differs')
    await expect(buildLegacyMigration(root, { schemaVersion: 1, assets: [{ source: original.source, kind: 'image', sourceSha256: original.sha256, assetId: 'test-only' }] })).rejects.toThrow('Wrong mapped kind')
  })
})

describe('fail-closed source conversion', () => {
  it('reads literal environment fallbacks without executing the original module', async () => {
    const source = await readFile(resolve(root, 'src/data/site.js'), 'utf8')
    expect(extractSiteDefaults(source).music).toEqual({ source: 'tencent', sourceType: 'playlist', sourceId: '9206816111', name: 'QQ Music Playlist' })
    expect(() => extractSiteDefaults(source.replace("'9206816111'", 'process.exit(99)'))).toThrow('Unsupported dynamic configuration')
  })
  it.each([
    '<p><a href="javascript:alert(1)">bad</a></p>', '<p><a href="data:text/html,a">bad</a></p>',
    '<iframe src="https://example.com"></iframe>', '<p onclick="alert(1)">bad</p>', '<script>bad()</script>',
    '<p><a href="https://example.com">wrong</p></a>', '<p>&unknown;</p>',
  ])('does not admit executable HTML, dangerous URLs or silently repair malformed source: %s', source => {
    expect(() => convertLegacyAbout(source)).toThrow()
  })
  it('preserves rendered entity text and safe link targets while omitting original styling', () => {
    const doc = convertLegacyAbout('<h3>标题</h3><p>&nbsp;你好<a href="https://example.com" style="color:red">原文 &raquo;</a></p>')
    expect(doc.content).toEqual([
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '标题' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '\u00a0你好' }, { type: 'text', text: '原文 »', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] },
    ])
  })
  it('keeps paragraph boundaries and rejects iframe, dangerous links, path traversal and unsupported Markdown', () => {
    expect(parseLegacyMarkdown('第一段\n同段\n\n第二段')).toEqual([{ type: 'paragraph', text: '第一段\n同段' }, { type: 'paragraph', text: '第二段' }])
    for (const source of ['<iframe src="https://example.com"></iframe>', '![x](javascript:alert)', '![x](content/../private.png)', '**unexpected markdown**']) expect(() => parseLegacyMarkdown(source)).toThrow()
  })
  it('rejects duplicate source mappings, extra fields and one asset ID assigned different original bytes', () => {
    const entry = { source: 'content/a.jpg', assetId: 'test-only', kind: 'image', sourceSha256: 'a'.repeat(64) }
    expect(AssetMappingSchema.safeParse({ schemaVersion: 1, assets: [entry, entry] }).success).toBe(false)
    expect(AssetMappingSchema.safeParse({ schemaVersion: 1, assets: [{ ...entry, body: '<html>' }] }).success).toBe(false)
    expect(AssetMappingSchema.safeParse({ schemaVersion: 1, assets: [entry, { ...entry, source: 'content/b.jpg', sourceSha256: 'b'.repeat(64) }] }).success).toBe(false)
  })
})
