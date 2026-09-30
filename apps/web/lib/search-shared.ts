export const SEARCH_CATEGORIES = {
  creation: '创作', photography: '摄影', about: '关于', fitness: '健身',
} as const
export type SearchCategory = keyof typeof SEARCH_CATEGORIES
export const SEARCH_PAGE_SIZE = 8
export const SEARCH_QUERY_LIMIT = 100

export function searchBundlePath(releaseId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(releaseId)) throw new Error('Invalid search release')
  return `/search-index/${releaseId}/`
}

export function searchResultPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 160) return null
  if (!/^\/(?:about|fitness|(?:creations|photography)\/[a-z0-9]+(?:-[a-z0-9]+)*)\/?$/u.test(value)) return null
  return value.replace(/\/$/u, '')
}

export interface SearchExcerptPart { text: string; highlighted: boolean }
function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/giu, (match, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? match
    const point = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : ''
  })
}

/** Pagefind supplies marked excerpts. Return text segments, never trusted HTML. */
export function searchExcerpt(value: unknown): SearchExcerptPart[] {
  if (typeof value !== 'string') return []
  const parts: SearchExcerptPart[] = []
  let highlighted = false
  for (const piece of value.slice(0, 4000).split(/(<\/?mark>)/giu)) {
    if (piece.toLowerCase() === '<mark>') { highlighted = true; continue }
    if (piece.toLowerCase() === '</mark>') { highlighted = false; continue }
    const text = decodeEntities(piece.replace(/<[^>]*>/gu, '')).replace(/\u200b/gu, '')
    if (text) parts.push({ text, highlighted })
  }
  return parts
}
