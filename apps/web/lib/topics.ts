import type { Topic, TopicMember } from '@xvyin/contracts'
import type { SiteSnapshot } from './models'
import { albumImageIds, creationImageIds } from './publication-metadata'

type TopicSite = Pick<SiteSnapshot, 'settings' | 'creations' | 'albums' | 'assets'>
export interface TopicEntry {
  id: string; collection: TopicMember['collection']; title: string; summary: string; href: string
  coverAssetId?: string; label: string
}

/** Resolve every label and cover from this release; references never carry copied draft text. */
export function topicEntries(topic: Topic, snapshot: TopicSite): TopicEntry[] {
  return topic.members.flatMap(member => {
    const creation = member.collection === 'creations' ? snapshot.creations.find(item => item.id === member.id) : undefined
    const album = member.collection === 'albums' ? snapshot.albums.find(item => item.id === member.id) : undefined
    const entry = creation || album
    if (!entry) return []
    const images = creation ? creationImageIds(creation) : albumImageIds(album!)
    const coverAssetId = images.find(id => id && snapshot.assets.some(asset => asset.id === id && asset.kind === 'image' && asset.variants.some(variant => ['content', 'large', 'thumb'].includes(variant.role)))) || undefined
    return [{ id: member.id, collection: member.collection, title: entry.title, summary: creation?.summary || album?.description || '',
      href: `/${creation ? 'creations' : 'photography'}/${entry.slug}`, coverAssetId,
      label: album ? '摄影' : creation?.blocks.some(block => block.type === 'video') ? '视频创作' : '创作' }]
  })
}
export function topicMemberships(member: TopicMember, snapshot: TopicSite) {
  return (snapshot.settings.topics || []).filter(topic => topic.enabled).flatMap(topic => {
    const entries = topicEntries(topic, snapshot), index = entries.findIndex(entry => entry.collection === member.collection && entry.id === member.id)
    return index < 0 ? [] : [{ topic, position: index + 1, total: entries.length, previous: entries[index - 1], next: entries[index + 1] }]
  })
}
