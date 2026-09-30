import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { CreationDraftSchema, SiteSettingsSchema } from '@xvyin/contracts'
import { Releases } from '../src/releases'
import { Records } from '../src/records'
import { MemoryStore } from '../src/store/memory'
import { publicSnapshot, PublicSnapshotSchema } from '../../../apps/web/lib/build-snapshot'
import { publicationFeeds } from '../../../apps/web/lib/publication-metadata'
import { yearbook } from '../../../apps/web/lib/yearbook'
import { searchRecords } from '../../../scripts/v3/search-index'
import { searchResultPath } from '../../../apps/web/lib/search-shared'

const clock = Date.UTC(2026, 8, 29, 16, 30), codeSha = 'a'.repeat(40), timestamp = new Date(clock).toISOString()
let mf: Miniflare, bucket: R2Bucket, store: MemoryStore, records: Records, releases: Releases
const note = { kind: 'note', title: '随记 2026.09.30', slug: 'note-20260930-a', blocks: [{ id: 'body', type: 'quote', text: '公开随记的文字。' }] }
beforeAll(async () => {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("test"); } }', compatibilityDate: '2026-09-11', r2Buckets: ['JOURNAL'] }), telemetry: { enabled: false }, cf: false })
  bucket = await mf.getR2Bucket('JOURNAL') as unknown as R2Bucket
})
afterAll(async () => { await mf.dispose() })
beforeEach(async () => {
  const objects = await bucket.list(); if (objects.objects.length) await bucket.delete(objects.objects.map(item => item.key))
  store = new MemoryStore(); records = new Records(store, () => clock); releases = new Releases(store, bucket, () => clock, codeSha)
})
async function publish(settings: unknown, includeNote = true) {
  const site = await records.save('settings', SiteSettingsSchema, settings, 'admin', 'site')
  const changes = [{ collection: 'settings', id: site.id, version: site.version, action: 'publish' }]
  if (includeNote) {
    const creation = await records.save('creations', CreationDraftSchema, note, 'admin', 'note')
    changes.push({ collection: 'creations', id: creation.id, version: creation.version, action: 'publish' })
  }
  return releases.create({ changes, expectedReleaseId: null }, 'admin')
}

describe('life journal cross-layer public boundary', () => {
  it('publishes a note once under its canonical route across search, feeds and the yearbook', async () => {
    const job = await publish({ now: { enabled: true, text: '正在整理公开影像。', updatedAt: timestamp } })
    const snapshot = await releases.snapshot(job.id), site = publicSnapshot(snapshot), search = searchRecords(snapshot)
    expect(site.creations[0]?.kind).toBe('note')
    expect(search.records.filter(item => item.filters.category.includes('note'))).toMatchObject([{ url: '/creations/note-20260930-a', content: expect.stringContaining('公开随记') }])
    expect(search.records.find(item => item.url === '/now')).toMatchObject({ content: expect.stringContaining('正在整理公开影像。'), filters: { category: ['now'] } })
    expect(searchResultPath('/now')).toBe('/now')
    expect(searchResultPath('/creations/note-20260930-a')).toBe('/creations/note-20260930-a')
    const feed = publicationFeeds(site, 'https://xvyin.com')
    expect(feed.json.items).toHaveLength(1)
    expect(feed.json.items[0]).toMatchObject({ id: 'urn:xvyin:creation:note', url: 'https://xvyin.com/creations/note-20260930-a', content_text: '公开随记的文字。' })
    expect(feed.rss).toContain('公开随记的文字。')
    expect(yearbook(site).years[0]).toMatchObject({ year: '2026', counts: { notes: 1, creations: 0 }, entries: [{ date: '2026-09-30', kind: 'note', href: '/creations/note-20260930-a' }] })
  })

  it('removes disabled Now from publication and search while preserving the editable private draft', async () => {
    const job = await publish({ now: { enabled: false, text: 'PRIVATE_NOW_CANARY', updatedAt: timestamp } })
    const snapshot = await releases.snapshot(job.id)
    expect(PublicSnapshotSchema.parse(snapshot).settings).not.toHaveProperty('now')
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_NOW_CANARY')
    expect(JSON.stringify(searchRecords(snapshot))).not.toContain('PRIVATE_NOW_CANARY')
    expect(searchRecords(snapshot).records.some(item => item.url === '/now')).toBe(false)
    expect(await store.get('settings/site')).toMatchObject({ draft: { now: { text: 'PRIVATE_NOW_CANARY', enabled: false } } })
  })

  it('rebuilds an older public snapshot without adopting newer unpublished notes or Now drafts', async () => {
    const job = await publish({ intro: '旧公开介绍' }, false), original = await releases.snapshot(job.id)
    expect(original.settings).not.toHaveProperty('now')
    await bucket.put('active-release.json', JSON.stringify({ releaseId: job.id, schemaVersion: 1, manifestSha256: 'b'.repeat(64), activatedAt: timestamp, codeSha, runId: 'legacy' }))
    await records.save('settings', SiteSettingsSchema, { now: { enabled: true, text: 'UNPUBLISHED_NOW_CANARY', updatedAt: timestamp } }, 'admin', 'site', 1)
    await records.save('creations', CreationDraftSchema, { ...note, title: 'UNPUBLISHED_NOTE_CANARY' }, 'admin', 'note')
    const candidate = await releases.create({ changes: [], expectedReleaseId: job.id, rebuildPublished: true }, 'admin')
    const rebuilt = await releases.snapshot(candidate.id)
    expect({ ...rebuilt, releaseId: original.releaseId }).toEqual(original)
    expect(publicSnapshot(rebuilt).settings).not.toHaveProperty('now')
    expect(JSON.stringify(searchRecords(rebuilt))).not.toMatch(/UNPUBLISHED_NOW_CANARY|UNPUBLISHED_NOTE_CANARY/u)
    expect(publicationFeeds(publicSnapshot(rebuilt), 'https://xvyin.com').json.items).toEqual([])
  })
})
