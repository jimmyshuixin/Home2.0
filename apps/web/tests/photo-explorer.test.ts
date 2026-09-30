import { describe, expect, it } from 'vitest'
import {
  emptyPhotoFilters, filterPhotoEntries, normalizePhotoEquipment, photoExplorerEntries,
  photoExplorerPage, photoExplorerQuery, photoExplorerQueryValues, photoFilterOptions,
  PHOTO_PAGE_SIZE, PHOTO_UNKNOWN, type ExplorerAlbum,
} from '../lib/photo-explorer'
import { photoViewerTarget } from '../lib/photo-lightbox'
import type { PhotographyInfo } from '../lib/photography'

const albums: ExplorerAlbum[] = [
  { id: 'album-a', slug: 'light', title: '光', photos: [
    { id: 'first', assetId: 'a', alt: '光线', status: 'published', photoDate: '2024-02-29' },
    { id: 'second', assetId: 'b', alt: '夜色', status: 'published' },
    { id: 'third', assetId: 'c', alt: '无记录', status: 'published' },
  ] },
  { id: 'album-b', slug: 'journey', title: '途中', photos: [{ id: 'first', assetId: 'd', alt: '山', status: 'published' }] },
]
const metadata: Record<string, PhotographyInfo> = {
  a: { cameraMake: 'Canon', cameraModel: 'EOS R6 Mark II', lensModel: 'RF24-70mm F2.8', focalLengthMm: 35, takenDate: '2023-12-31' },
  b: { cameraMake: 'CANON', cameraModel: 'canon EOS-R6 Mark II', lensModel: 'RF24-70mm F2.8', focalLengthMm: 50, takenAt: '2025-12-31T23:59:59', timezoneOffset: '-10:00' },
  c: { cameraModel: '  ', focalLengthMm: 0, takenDate: '2025-02-29' },
  d: { cameraMake: 'Fujifilm', cameraModel: 'X-T5', focalLengthMm: 35, takenDate: '2026-01-01' },
}
const entries = () => photoExplorerEntries(albums, id => metadata[id])

describe('public photography discovery', () => {
  it('uses corrected capture dates first, preserves the recorded local year, and never substitutes publication dates', () => {
    const all = entries()
    expect(all.map(entry => entry.date)).toEqual(['2026-01-01', '2025-12-31', '2024-02-29', ''])
    expect(all.find(entry => entry.photo.assetId === 'a')?.values.year).toBe('2024')
    const unknown = photoExplorerEntries([{ ...albums[0]!, publishedAt: '2026-09-30', photos: [{ assetId: 'x', alt: '未知', photoDate: '2025-02-29' }] } as ExplorerAlbum], () => undefined)[0]!
    expect(unknown.values.year).toBe(PHOTO_UNKNOWN)
    expect(unknown.photo.photoDate).toBeUndefined()
  })

  it('merges make/model typography without collapsing decimal apertures or inventing zero focal lengths', () => {
    const all = entries(), filters = emptyPhotoFilters()
    const cameras = photoFilterOptions(all, filters, 'camera')
    expect(cameras.find(option => option.value === 'canoneosr6markii')?.count).toBe(2)
    expect(normalizePhotoEquipment('ＣＡＮＯＮ EOS-R6 Mark II')).toBe('canoneosr6markii')
    expect(normalizePhotoEquipment('RF24-70mm F2.8')).not.toBe(normalizePhotoEquipment('RF24-70mm F28'))
    expect(photoFilterOptions(all, filters, 'focal')).toEqual([
      { value: '35', label: '35 mm', count: 2 }, { value: '50', label: '50 mm', count: 1 }, { value: PHOTO_UNKNOWN, label: '未记录焦距', count: 1 },
    ])
    for (const focalLengthMm of [0, -1, NaN, Infinity, 0.0001]) {
      expect(photoExplorerEntries([albums[1]!], () => ({ focalLengthMm }))[0]?.values.focal).toBe(PHOTO_UNKNOWN)
    }
  })

  it('intersects filters and counts other available conditions while retaining zero-count recovery options', () => {
    const all = entries(), filters = { ...emptyPhotoFilters(), camera: 'canoneosr6markii', focal: '35' }
    expect(filterPhotoEntries(all, filters).map(entry => entry.photo.assetId)).toEqual(['a'])
    const years = photoFilterOptions(all, filters, 'year')
    expect(years.find(option => option.value === '2024')?.count).toBe(1)
    expect(years.find(option => option.value === '2026')?.count).toBe(0)
    expect(filterPhotoEntries(all, { ...filters, year: '2026' })).toHaveLength(0)
    expect(filterPhotoEntries(all, { ...emptyPhotoFilters(), camera: PHOTO_UNKNOWN }).map(entry => entry.photo.assetId)).toEqual(['c'])
  })

  it('projects only public browsing fields and excludes hidden and draft photos', () => {
    const privatePhoto = { ...albums[0]!.photos[0]!, map: { latitude: 12.3456789, longitude: 98.7654321 }, location: { latitude: 12.3456789, longitude: 98.7654321, precision: 'city' as const, label: '公开城市' }, owner: 'private-owner' }
    const all = photoExplorerEntries([{ ...albums[0]!, photos: [privatePhoto, { ...privatePhoto, id: 'draft', status: 'draft' }, { ...privatePhoto, id: 'hidden', status: 'hidden' }] }], () => ({ ...metadata.a!, GPSLatitude: 12.3456789, serialNumber: 'private-serial' } as PhotographyInfo))
    expect(all).toHaveLength(1)
    expect(Object.keys(all[0]!.photo).sort()).toEqual(['alt', 'assetId', 'caption', 'id', 'photoDate', 'title'])
    expect(JSON.stringify(all)).not.toMatch(/12\.3456789|98\.7654321|private-owner|private-serial|latitude|longitude|GPS/iu)
  })

  it('round-trips shareable filters, rejects duplicate/malformed query values, and sanitizes pagination', () => {
    const parsed = photoExplorerQuery({ year: '2024', camera: 'Canon EOS-R6 Mark II', lens: PHOTO_UNKNOWN, focal: '35.00', page: '3' })
    expect(parsed).toEqual({ filters: { year: '2024', camera: 'canoneosr6markii', lens: PHOTO_UNKNOWN, focal: '35' }, page: 3 })
    expect(photoExplorerQuery(photoExplorerQueryValues(parsed.filters, parsed.page))).toEqual(parsed)
    expect(photoExplorerQuery({ year: ['2024', '2025'], lens: null, focal: '0', page: 'Infinity' })).toEqual({ filters: emptyPhotoFilters(), page: 1 })
    expect(photoExplorerQuery({ focal: 'NaN', page: '1.5' }).page).toBe(1)
    expect(photoExplorerQueryValues(emptyPhotoFilters()).page).toBeUndefined()
    expect(Object.keys(photoExplorerQueryValues(parsed.filters))).not.toContain('preview')
  })

  it('bounds rendering to a page and recovers safely from stale or extremely large page links', () => {
    const all = Array.from({ length: 53 }, (_, index) => index)
    expect(photoExplorerPage(all, 1).entries).toHaveLength(PHOTO_PAGE_SIZE)
    expect(photoExplorerPage(all, 2)).toEqual({ page: 2, pageCount: 3, start: 25, end: 48, entries: all.slice(24, 48) })
    expect(photoExplorerPage(all, 9999)).toEqual({ page: 3, pageCount: 3, start: 49, end: 53, entries: all.slice(48) })
    expect(photoExplorerPage([], 999)).toEqual({ page: 1, pageCount: 1, start: 0, end: 0, entries: [] })
    expect(photoExplorerPage(all, NaN).page).toBe(1)
  })

  it('keeps source album and real photo targets across a combined viewer, including colliding photo IDs', () => {
    const all = entries(), contexts = Object.fromEntries(all.map(entry => [entry.key, entry.context]))
    const first = all.find(entry => entry.photo.assetId === 'a')!, secondAlbum = all.find(entry => entry.photo.assetId === 'd')!
    expect(first.key).not.toBe(secondAlbum.key)
    expect(photoViewerTarget(first.photo, undefined, contexts)).toEqual({ type: 'photo', id: 'first', parentId: 'album-a' })
    expect(photoViewerTarget(secondAlbum.photo, undefined, contexts)).toEqual({ type: 'photo', id: 'first', parentId: 'album-b' })
    expect(photoViewerTarget(albums[0]!.photos[0], 'album-a')).toEqual({ type: 'photo', id: 'first', parentId: 'album-a' })
    expect(photoViewerTarget({ assetId: 'asset', alt: '照片' }, 'album-a')).toBeUndefined()
    expect(photoViewerTarget(first.photo, undefined, { [first.key]: { ...first.context, photoId: undefined } })).toBeUndefined()
  })
})
