import type { Album, Asset, Creation, RichNode, SiteSnapshot } from './models'

export function richTextPlain(node: RichNode): string {
  if (node.type === 'text') return node.text
  if (node.type === 'hardBreak') return '\n'
  return node.content.map(child => richTextPlain(child)).join(['doc', 'bulletList', 'orderedList', 'listItem'].includes(node.type) ? '\n' : '')
}
export function creationPlain(entry: Creation): string {
  return entry.blocks.map(block => {
    switch (block.type) {
      case 'richtext': return richTextPlain(block.document)
      case 'image': return block.caption || block.alt
      case 'compare': return [block.before.label, block.before.alt, block.after.label, block.after.alt, block.caption].filter(Boolean).join('\n')
      case 'gallery': return block.items.map(item => item.caption || item.alt).join('\n')
      case 'audio': return [block.title, block.transcript].filter(Boolean).join('\n')
      case 'video': return block.transcript || ''
      case 'quote': return [block.text, block.attribution].filter(Boolean).join('\n')
      case 'code': return block.code
      case 'file': return [block.label, block.description].filter(Boolean).join('\n')
    }
  }).filter(Boolean).join('\n\n')
}
export function xmlText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/gu, '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!)
}
export function absolutePublicUrl(value: string, origin: string): string | undefined {
  if (!value || /[\u0000-\u0020\\]/u.test(value) || value.startsWith('//') || value.startsWith('#')) return undefined
  try { const url = new URL(value, origin); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}
/** Select only an already-published display derivative, never an original/download. */
export function sharingImage(assets: Asset[], candidates: Array<string | null | undefined>, origin: string) {
  for (const id of candidates) {
    const asset = assets.find(item => item.id === id && item.kind === 'image')
    for (const role of ['content', 'large', 'thumb']) {
      const variant = asset?.variants.find(item => item.role === role && /^image\//u.test(item.mime))
      const url = variant && absolutePublicUrl(variant.url, origin)
      if (url && variant && (variant.mime === 'image/jpeg' || variant.mime === 'image/png' || variant.mime === 'image/webp')) return { url, width: variant.width, height: variant.height, type: variant.mime }
    }
  }
  return { url: `${origin}/brand/ink-home.webp`, width: undefined, height: undefined, type: 'image/webp' as const }
}
export function creationImageIds(entry: Creation): Array<string | null | undefined> {
  return [entry.coverAssetId, ...entry.blocks.flatMap(block => block.type === 'image' ? [block.assetId] : block.type === 'compare' ? [block.before.assetId, block.after.assetId] : block.type === 'gallery' ? block.items.map(item => item.assetId) : block.type === 'video' ? [block.posterAssetId] : block.type === 'audio' ? [block.coverAssetId] : [])]
}
export function albumImageIds(album: Album): Array<string | null | undefined> {
  return [album.coverAssetId, ...album.photos.filter(photo => photo.status === 'published').sort((a, b) => a.sortOrder - b.sortOrder).map(photo => photo.assetId)]
}
/** Call only with the strict, release-time public projection. No asset metadata enters feeds. */
export function publicationFeeds(site: SiteSnapshot, origin: string) {
  const items = [
    ...site.creations.map(entry => ({ id: `urn:xvyin:creation:${entry.id}`, url: `${origin}/creations/${encodeURIComponent(entry.slug)}`, title: entry.title, summary: entry.summary, content_text: creationPlain(entry) || entry.summary || entry.title, date_published: entry.publishedAt, tags: entry.tags })),
    ...site.albums.map(album => ({ id: `urn:xvyin:album:${album.id}`, url: `${origin}/photography/${encodeURIComponent(album.slug)}`, title: album.title, summary: album.description, content_text: [album.description, ...album.photos.filter(photo => photo.status === 'published').sort((a, b) => a.sortOrder - b.sortOrder).map(photo => photo.caption || photo.alt)].filter(Boolean).join('\n\n') || album.title, date_published: album.publishedAt, tags: ['摄影'] }))
  ].sort((a, b) => b.date_published.localeCompare(a.date_published) || a.id.localeCompare(b.id)).slice(0, 100)
  const title = `${site.settings.siteTitle} · 更新`, description = '创作、随记与摄影的公开更新。'
  const json = { version: 'https://jsonfeed.org/version/1.1', title, home_page_url: origin, feed_url: `${origin}/feed.json`, description, language: 'zh-CN', items }
  const rss = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xmlText(title)}</title><link>${xmlText(origin)}</link><description>${xmlText(description)}</description><language>zh-CN</language><atom:link href="${xmlText(origin)}/feed.xml" rel="self" type="application/rss+xml"/>${items.map(item => `<item><title>${xmlText(item.title)}</title><link>${xmlText(item.url)}</link><guid isPermaLink="false">${xmlText(item.id)}</guid><pubDate>${new Date(item.date_published).toUTCString()}</pubDate><description>${xmlText(item.content_text)}</description>${item.tags.map(tag => `<category>${xmlText(tag)}</category>`).join('')}</item>`).join('')}</channel></rss>\n`
  return { json, rss }
}
