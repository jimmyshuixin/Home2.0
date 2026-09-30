import { describe, expect, it } from 'vitest'
import { CreationDraftSchema, PublishableAlbumSchema, TopicSchema } from '@xvyin/contracts'
import { publicSnapshot, PublicSnapshotSchema } from '../lib/build-snapshot'
import { topicEntries, topicMemberships } from '../lib/topics'
import { searchRecords } from '../../../scripts/v3/search-index'
import { searchResultPath } from '../lib/search-shared'

const emptySnapshot = (releaseId: string) => PublicSnapshotSchema.parse({ schemaVersion: 1, releaseId, settings: {}, creations: [], albums: [], fitness: { settings: {}, entries: [] }, playlists: [], assets: [], routeAliases: {} })
function fixture() {
  const snapshot = emptySnapshot('topic-release'), publishedAt = '2026-09-30T00:00:00.000Z'
  snapshot.creations = [{ ...CreationDraftSchema.parse({ title: '文章公开标题', slug: 'article', blocks: [{ id: 'q', type: 'quote', text: '正文' }] }), id: 'article', revisionId: 'r1', publishedAt, formats: ['text'] }]
  snapshot.albums = [{ ...PublishableAlbumSchema.parse({ title: '相册公开标题', slug: 'album' }), photos: [], id: 'album', revisionId: 'r2', publishedAt }]
  snapshot.settings.topics = [TopicSchema.parse({ id: 'topic', slug: 'journey', title: '专题标题', intro: '专题引言', enabled: true, members: [{ collection: 'albums', id: 'album' }, { collection: 'creations', id: 'article' }] })]
  return snapshot
}
describe('release-bound topics, navigation and search', () => {
  it('resolves mixed entries in curator order and supplies correct previous/next links', () => {
    const site = publicSnapshot(fixture()), topic = site.settings.topics![0]!
    expect(topicEntries(topic, site).map(entry => [entry.title, entry.href])).toEqual([['相册公开标题', '/photography/album'], ['文章公开标题', '/creations/article']])
    const membership = topicMemberships({ collection: 'creations', id: 'article' }, site)[0]!
    expect(membership).toMatchObject({ position: 2, total: 2, previous: { href: '/photography/album' } })
    expect(membership.next).toBeUndefined()
    expect(topicMemberships({ collection: 'albums', id: 'missing' }, site)).toEqual([])
  })
  it('rejects private or unavailable references at the SSG and search boundaries', () => {
    const snapshot = fixture()
    snapshot.settings.topics![0]!.members.push({ collection: 'creations', id: 'private-id' })
    expect(PublicSnapshotSchema.safeParse(snapshot).success).toBe(false)
    expect(() => searchRecords(snapshot)).toThrow()
    snapshot.settings.topics![0]!.members.pop()
    snapshot.settings.topics![0]!.enabled = false
    expect(PublicSnapshotSchema.safeParse(snapshot).success).toBe(false)
    snapshot.settings.topics![0]!.enabled = true
    snapshot.settings.topics![0]!.members = []
    expect(PublicSnapshotSchema.safeParse(snapshot).success).toBe(false)
  })
  it('indexes only public topic text and member titles under a valid topic route', () => {
    const result = searchRecords(fixture()), topic = result.records.find(record => record.url === '/topics/journey')!
    expect(result.releaseId).toBe('topic-release')
    expect(topic.filters.category).toEqual(['topic'])
    expect(topic.content).toContain('相册公开标题\n文章公开标题')
    expect(searchResultPath('/topics/journey')).toBe('/topics/journey')
    expect(searchResultPath('/topics/../private')).toBeNull()
  })
  it('leaves older snapshots untouched and renders no invented topic content', () => {
    const snapshot = emptySnapshot('legacy'), before = JSON.stringify(snapshot)
    expect(publicSnapshot(snapshot).settings).not.toHaveProperty('topics')
    expect(topicMemberships({ collection: 'creations', id: 'article' }, publicSnapshot(snapshot))).toEqual([])
    expect(searchRecords(snapshot).records.some(record => record.url.startsWith('/topics/'))).toBe(false)
    expect(JSON.stringify(snapshot)).toBe(before)
  })
});
