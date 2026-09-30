import type { Photo } from './models'
import type { PhotographyInfo } from './photography'
import type { PhotoContext } from './photo-lightbox'

export const PHOTO_UNKNOWN = 'unknown'
export const PHOTO_PAGE_SIZE = 24
export const photoFilterKeys = ['year', 'camera', 'lens', 'focal'] as const
export type PhotoFilterKey = typeof photoFilterKeys[number]
export type PhotoFilters = Record<PhotoFilterKey, string>
export type ExplorerAlbum = { id: string; slug: string; title: string; sortOrder?: number; photos: readonly Photo[] }
export type PhotoExplorerEntry = {
  key: string; photo: Photo; context: PhotoContext; date: string
  values: Record<PhotoFilterKey, string>; labels: Record<PhotoFilterKey, string>
}
export type PhotoFilterOption = { value: string; label: string; count: number }
export const emptyPhotoFilters = (): PhotoFilters => ({ year: '', camera: '', lens: '', focal: '' })

/** Ignore typography/case differences but preserve decimal lens apertures. */
export function normalizePhotoEquipment(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/(?<!\d)\.|\.(?!\d)/gu, '').replace(/[^\p{L}\p{N}.]/gu, '')
}
function equipment(make = '', model = ''): string {
  make = make.trim().replace(/\s+/gu, ' '); model = model.trim().replace(/\s+/gu, ' ')
  if (!model) return make
  return make && !normalizePhotoEquipment(model).startsWith(normalizePhotoEquipment(make)) ? `${make} ${model}` : model
}
function captureDate(value?: string | null): string {
  const date = value?.slice(0, 10) || ''
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return ''
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : ''
}
function focalValue(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100000
    ? String(Number(value.toFixed(2))) === '0' ? '' : String(Number(value.toFixed(2))) : ''
}

/** Explicit projection: no location, original assets, upload dates, or raw EXIF enter this index. */
export function photoExplorerEntries(albums: readonly ExplorerAlbum[], photographyFor: (assetId: string) => PhotographyInfo | undefined): PhotoExplorerEntry[] {
  const entries: PhotoExplorerEntry[] = []
  const sortedAlbums = [...albums].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.id.localeCompare(b.id))
  for (const album of sortedAlbums) {
    const photos = [...album.photos].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.id || '').localeCompare(b.id || ''))
    photos.forEach((photo, index) => {
      // Public snapshots already enforce publication; keep this safe for other callers too.
      if (photo.status && photo.status !== 'published') return
      const info = photographyFor(photo.assetId)
      const date = captureDate(photo.photoDate) || captureDate(info?.takenDate) || captureDate(info?.takenAt)
      const camera = equipment(info?.cameraMake, info?.cameraModel), lens = equipment(info?.lensMake, info?.lensModel)
      const focal = focalValue(info?.focalLengthMm)
      const key = `${encodeURIComponent(album.id)}/${encodeURIComponent(photo.id || `${photo.assetId}/${index}`)}`
      entries.push({
        key, date,
        // Composite internal IDs prevent collisions when a photo appears in multiple albums.
        photo: { id: key, assetId: photo.assetId, alt: photo.alt, title: photo.title, caption: photo.caption, ...(date ? { photoDate: date } : {}) },
        context: { albumId: album.id, photoId: photo.id, albumTitle: album.title, albumSlug: album.slug },
        values: { year: date.slice(0, 4) || PHOTO_UNKNOWN, camera: normalizePhotoEquipment(camera) || PHOTO_UNKNOWN, lens: normalizePhotoEquipment(lens) || PHOTO_UNKNOWN, focal: focal || PHOTO_UNKNOWN },
        labels: { year: date.slice(0, 4) || '未记录年份', camera: camera || '未记录相机', lens: lens || '未记录镜头', focal: focal ? `${focal} mm` : '未记录焦距' },
      })
    })
  }
  // Capture date, never upload/publication time. Stable ordering retains album curation on ties.
  return entries.sort((a, b) => b.date.localeCompare(a.date))
}

export function filterPhotoEntries(entries: readonly PhotoExplorerEntry[], filters: PhotoFilters, except?: PhotoFilterKey): PhotoExplorerEntry[] {
  return entries.filter(entry => photoFilterKeys.every(key => key === except || !filters[key] || entry.values[key] === filters[key]))
}

/** Facet counts respect all other filters; unavailable choices stay visible for a recoverable link. */
export function photoFilterOptions(entries: readonly PhotoExplorerEntry[], filters: PhotoFilters, key: PhotoFilterKey): PhotoFilterOption[] {
  const options = new Map<string, PhotoFilterOption>()
  for (const entry of entries) {
    const value = entry.values[key]
    if (!options.has(value)) options.set(value, { value, label: entry.labels[key], count: 0 })
  }
  for (const entry of filterPhotoEntries(entries, filters, key)) options.get(entry.values[key])!.count++
  return [...options.values()].sort((a, b) => {
    if (a.value === PHOTO_UNKNOWN) return 1
    if (b.value === PHOTO_UNKNOWN) return -1
    if (key === 'year') return Number(b.value) - Number(a.value)
    if (key === 'focal') return Number(a.value) - Number(b.value)
    return a.label.localeCompare(b.label, 'zh-CN', { numeric: true })
  })
}

type Query = Record<string, unknown>
export function photoExplorerQuery(query: Query): { filters: PhotoFilters; page: number } {
  const single = (key: string) => typeof query[key] === 'string' ? (query[key] as string).slice(0, 200) : ''
  const filters = emptyPhotoFilters()
  for (const key of photoFilterKeys) {
    const value = single(key)
    if (value === PHOTO_UNKNOWN) filters[key] = value
    else if (key === 'year') filters[key] = /^\d{4}$/u.test(value) ? value : ''
    else if (key === 'focal') filters[key] = /^\d+(\.\d+)?$/u.test(value) ? focalValue(Number(value)) : ''
    else filters[key] = normalizePhotoEquipment(value)
  }
  const rawPage = single('page'), number = Number(rawPage)
  return { filters, page: /^\d+$/u.test(rawPage) && Number.isSafeInteger(number) && number > 0 ? number : 1 }
}

export function photoExplorerQueryValues(filters: PhotoFilters, page = 1): Record<PhotoFilterKey | 'page' | 'view', string | undefined> {
  return { view: 'photos', year: filters.year || undefined, camera: filters.camera || undefined, lens: filters.lens || undefined, focal: filters.focal || undefined, page: page > 1 ? String(page) : undefined }
}

export function photoExplorerPage<T>(entries: readonly T[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(entries.length / PHOTO_PAGE_SIZE))
  const page = Math.min(pageCount, Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1))
  return { page, pageCount, start: entries.length ? (page - 1) * PHOTO_PAGE_SIZE + 1 : 0, end: Math.min(page * PHOTO_PAGE_SIZE, entries.length), entries: entries.slice((page - 1) * PHOTO_PAGE_SIZE, page * PHOTO_PAGE_SIZE) }
}
