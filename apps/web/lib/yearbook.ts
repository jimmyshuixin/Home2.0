import type { SiteSnapshot } from './models'
import { creationImageIds } from './publication-metadata'

type YearbookSite = Pick<SiteSnapshot, 'creations' | 'albums' | 'fitness' | 'assets'>
export type YearbookKind = 'creation' | 'note' | 'photo' | 'fitness'
export type YearbookDateSource = 'published' | 'photo-manual' | 'photo-exif' | 'album-published' | 'fitness-entry' | 'unknown'
export type YearbookSource = { id: string; title: string; href: string }
export type YearbookEntry = {
  id: string; kind: YearbookKind; title: string; description: string; href: string
  date: string; dateSource: YearbookDateSource; imageAssetId?: string; imageAlt: string; sources: YearbookSource[]
}
export type YearbookCounts = { creations: number; notes: number; photos: number; fitness: number }
export type YearbookMonth = { month: string; entries: YearbookEntry[] }
export type YearbookYear = { year: string; entries: YearbookEntry[]; months: YearbookMonth[]; counts: YearbookCounts }
export type Yearbook = { years: YearbookYear[]; unknown: YearbookEntry[]; counts: YearbookCounts }

export const yearbookKindLabels: Record<YearbookKind, string> = { creation: '创作', note: '随记', photo: '摄影', fitness: '健身影像' }
export const yearbookDateLabels: Record<YearbookDateSource, string> = {
  published: '公开日期', 'photo-manual': '拍摄日期', 'photo-exif': '拍摄日期 · EXIF',
  'album-published': '拍摄日期未记录 · 按相册发布日收录', 'fitness-entry': '记录日期', unknown: '日期未详',
}

function calendarDate(value?: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return ''
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : ''
}

/** An instant belongs to its Shanghai calendar day; EXIF wall-clock dates never use this conversion. */
export function yearbookPublishedDate(value?: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !calendarDate(value.slice(0, 10))) return ''
  const instant = new Date(value)
  if (!Number.isFinite(instant.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant)
  return ['year', 'month', 'day'].map(name => parts.find(part => part.type === name)?.value).join('-')
}

export function yearbookCounts(entries: readonly YearbookEntry[]): YearbookCounts {
  const counts = { creations: 0, notes: 0, photos: 0, fitness: 0 }
  for (const entry of entries) counts[({ creation: 'creations', note: 'notes', photo: 'photos', fitness: 'fitness' } as const)[entry.kind]]++
  return counts
}

const compareEntries = (a: YearbookEntry, b: YearbookEntry) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)

/** Only public text, image IDs and dates are projected. No coordinates or private media fields are copied. */
export function yearbook(snapshot: YearbookSite): Yearbook {
  const assets = new Map(snapshot.assets.map(asset => [asset.id, asset]))
  const usableImage = (id?: string | null) => !!id && assets.get(id)?.kind === 'image' && assets.get(id)!.variants.some(variant => ['content', 'large', 'thumb'].includes(variant.role))
  const entries: YearbookEntry[] = []
  const creationIds = new Set<string>(), fitnessIds = new Set<string>()
  for (const creation of snapshot.creations) {
    if (creationIds.has(creation.id)) continue
    creationIds.add(creation.id)
    const kind = (creation as { kind?: string }).kind === 'note' ? 'note' : 'creation'
    const date = yearbookPublishedDate(creation.publishedAt)
    entries.push({ id: `creation/${creation.id}`, kind, title: creation.title, description: creation.summary,
      href: `/creations/${encodeURIComponent(creation.slug)}`, date, dateSource: date ? 'published' : 'unknown',
      imageAssetId: creationImageIds(creation).find(usableImage) || undefined, imageAlt: creation.title, sources: [] })
  }

  const photos = new Map<string, { entry: YearbookEntry; priority: number }>()
  const albums = [...snapshot.albums].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
  for (const album of albums) {
    const source = { id: album.id, title: album.title, href: `/photography/${encodeURIComponent(album.slug)}` }
    for (const photo of [...album.photos].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))) {
      if (photo.status !== 'published') continue
      const metadata = assets.get(photo.assetId)?.photography
      const manual = calendarDate(photo.photoDate)
      const exif = calendarDate(metadata?.takenDate) || calendarDate(metadata?.takenAt?.slice(0, 10))
      const published = yearbookPublishedDate(album.publishedAt)
      const date = manual || exif || published
      const priority = manual ? 3 : exif ? 2 : published ? 1 : 0
      const previous = photos.get(photo.assetId)
      const sources = previous?.entry.sources || []
      if (!sources.some(item => item.id === source.id)) sources.push(source)
      // Prefer an explicit photo date, then EXIF, then publication. Ties keep album curation order.
      if (previous && previous.priority >= priority) continue
      photos.set(photo.assetId, { priority, entry: {
        id: `photo/${photo.assetId}`, kind: 'photo', title: photo.caption || photo.alt || album.title,
        description: album.description, href: source.href, date,
        dateSource: manual ? 'photo-manual' : exif ? 'photo-exif' : published ? 'album-published' : 'unknown',
        imageAssetId: usableImage(photo.assetId) ? photo.assetId : undefined, imageAlt: photo.alt, sources,
      } })
    }
  }
  entries.push(...[...photos.values()].map(value => value.entry))

  for (const record of snapshot.fitness.entries) {
    if (fitnessIds.has(record.id)) continue
    fitnessIds.add(record.id)
    const date = calendarDate(record.entryDate)
    const photo = record.photos.find(item => item.status === 'published' && usableImage(item.assetId))
    entries.push({ id: `fitness/${record.id}`, kind: 'fitness', title: record.title, description: record.caption,
      href: '/fitness', date, dateSource: date ? 'fitness-entry' : 'unknown', imageAssetId: photo?.assetId,
      imageAlt: photo?.alt || record.title, sources: [] })
  }
  entries.sort(compareEntries)
  const groups = new Map<string, YearbookEntry[]>()
  for (const entry of entries) {
    if (!entry.date) continue
    const year = entry.date.slice(0, 4)
    if (!groups.has(year)) groups.set(year, [])
    groups.get(year)!.push(entry)
  }
  return {
    years: [...groups].sort(([a], [b]) => b.localeCompare(a)).map(([year, items]) => {
      const months = new Map<string, YearbookEntry[]>()
      for (const entry of items) {
        const month = entry.date.slice(5, 7)
        if (!months.has(month)) months.set(month, [])
        months.get(month)!.push(entry)
      }
      return { year, entries: items, counts: yearbookCounts(items), months: [...months].map(([month, entries]) => ({ month, entries })) }
    }),
    unknown: entries.filter(entry => !entry.date), counts: yearbookCounts(entries),
  }
}

/** Unknown or repeated query values fall back to the latest populated year. */
export function yearbookSelection(book: Yearbook, query: unknown): string {
  if (query === 'unknown' && book.unknown.length) return 'unknown'
  return typeof query === 'string' && book.years.some(item => item.year === query) ? query : book.years[0]?.year || (book.unknown.length ? 'unknown' : '')
}
