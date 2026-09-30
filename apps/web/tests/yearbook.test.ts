import { describe, expect, it } from 'vitest'
import { publicSnapshot } from '../lib/build-snapshot'
import { yearbook, yearbookPublishedDate, yearbookSelection } from '../lib/yearbook'

function fixture() {
  return publicSnapshot({ schemaVersion: 1, releaseId: 'yearbook-test', settings: {},
    creations: [{ id: 'essay', revisionId: 'r-essay', publishedAt: '2025-12-31T16:30:00.000Z', title: '跨年公开的文章', slug: 'new-year', summary: '正文摘要', formats: ['text'], blocks: [{ id: 'body', type: 'quote', text: '正文' }] }],
    albums: [{ id: 'album', revisionId: 'r-album', publishedAt: '2026-09-29T18:00:00.000Z', title: '光与影', slug: 'light', description: '相册说明', photos: [
      { id: 'manual', assetId: 'asset-manual', alt: '手动日期的照片', photoDate: '2024-02-29', status: 'published' },
      { id: 'exif', assetId: 'asset-exif', alt: '本地跨年之前', status: 'published' },
      { id: 'unknown', assetId: 'asset-unknown', alt: '没有拍摄日期', status: 'published' },
    ] }],
    fitness: { settings: { startDate: '2022-09-12' }, entries: [{ id: 'fitness', revisionId: 'r-fitness', publishedAt: '2026-09-30T00:00:00.000Z', entryDate: '2025-06-13', title: '一年之间', caption: '真实影像记录', photos: [] }] },
    playlists: [], assets: [
      { id: 'asset-manual', kind: 'image', photography: { takenDate: '2023-01-01' }, variants: [{ role: 'content', url: '/manual.webp', mime: 'image/webp', bytes: 1 }] },
      { id: 'asset-exif', kind: 'image', photography: { takenAt: '2025-12-31T23:59:59', timezoneOffset: '-10:00' }, variants: [{ role: 'content', url: '/exif.webp', mime: 'image/webp', bytes: 1 }] },
      { id: 'asset-unknown', kind: 'image', variants: [{ role: 'download', url: '/original.jpg', mime: 'image/jpeg', bytes: 1 }] },
    ], routeAliases: {} })
}

describe('public yearbook', () => {
  it('places publications in Shanghai, preserves local capture dates, and orders real events across collections', () => {
    const book = yearbook(fixture())
    expect(book.years.map(item => item.year)).toEqual(['2026', '2025', '2024'])
    expect(book.years[0]?.entries.map(item => [item.id, item.date, item.dateSource])).toEqual([
      ['photo/asset-unknown', '2026-09-30', 'album-published'], ['creation/essay', '2026-01-01', 'published'],
    ])
    expect(book.years[0]?.months.map(item => item.month)).toEqual(['09', '01'])
    expect(book.years[1]?.entries.map(item => item.date)).toEqual(['2025-12-31', '2025-06-13'])
    expect(book.years[2]?.entries[0]?.date).toBe('2024-02-29')
    expect(book.years.some(item => item.year === '2022')).toBe(false)
    expect(book.counts).toEqual({ creations: 1, notes: 0, photos: 3, fitness: 1 })
  })

  it('deduplicates photo assets across albums while retaining sources and choosing the strongest date evidence', () => {
    const site = fixture(), original = site.albums[0]!
    site.albums.push({ ...original, id: 'second', slug: 'second', title: '另一个相册', sortOrder: 2,
      photos: [{ ...original.photos[1]!, id: 'second-ref', photoDate: '2024-01-02' }] })
    site.albums.push({ ...original, id: 'third', slug: 'third', title: '第三个相册', sortOrder: 3,
      photos: [{ ...original.photos[1]!, id: 'third-ref', photoDate: '2023-01-01' }] })
    const book = yearbook(site), photo = book.years.flatMap(item => item.entries).find(item => item.id === 'photo/asset-exif')!
    expect(book.counts.photos).toBe(3)
    expect(photo).toMatchObject({ date: '2024-01-02', dateSource: 'photo-manual', href: '/photography/second' })
    expect(photo.sources.map(item => item.href)).toEqual(['/photography/light', '/photography/second', '/photography/third'])
    site.albums.reverse()
    expect(yearbook(site)).toEqual(book)
  })

  it('keeps malformed and missing dates out of invented years and never uses publication dates for fitness', () => {
    const site = fixture()
    site.creations[0]!.publishedAt = '2025-02-29T12:00:00Z'
    site.albums[0]!.publishedAt = '2026-09-30'
    site.albums[0]!.photos[0]!.photoDate = '2024-02-30'
    site.assets[0]!.photography = { takenDate: '2023-02-29' }
    site.fitness.entries[0]!.entryDate = ''
    const book = yearbook(site)
    expect(book.years.map(item => item.year)).toEqual(['2025'])
    expect(book.unknown.map(item => item.id).sort()).toEqual(['creation/essay', 'fitness/fitness', 'photo/asset-manual', 'photo/asset-unknown'])
    expect(book.unknown.every(item => item.dateSource === 'unknown' && item.date === '')).toBe(true)
  })

  it('uses public display assets only and does not propagate hidden photos, GPS, private URLs or extra fields', () => {
    const site = fixture(), photo = site.albums[0]!.photos[0]!
    Object.assign(photo, { map: { latitude: 12.3456789 }, location: { longitude: 98.7654321 }, owner: 'PRIVATE_CANARY' })
    site.albums[0]!.photos.push({ ...photo, id: 'hidden', assetId: 'hidden', alt: 'HIDDEN_CANARY', status: 'hidden' })
    Object.assign(site.assets[0]!, { privateUrl: '/private-original', gps: { latitude: 12.3456789 } })
    const book = yearbook(site), output = JSON.stringify(book)
    expect(book.counts.photos).toBe(3)
    expect(book.years[0]?.entries.find(item => item.id === 'photo/asset-unknown')?.imageAssetId).toBeUndefined()
    expect(output).not.toMatch(/PRIVATE_CANARY|HIDDEN_CANARY|12\.3456789|98\.7654321|latitude|longitude|private-original|original\.jpg|variants/u)
  })

  it('classifies notes separately and preserves their canonical creation detail URL', () => {
    const site = fixture()
    Object.assign(site.creations[0]!, { kind: 'note' })
    const book = yearbook(site)
    expect(book.counts).toMatchObject({ notes: 1, creations: 0 })
    expect(book.years[0]?.entries.find(item => item.kind === 'note')?.href).toBe('/creations/new-year')
  })

  it('does not mutate the snapshot or inflate record counts from duplicate source records', () => {
    const site = fixture()
    site.creations.push(site.creations[0]!)
    site.fitness.entries.push(site.fitness.entries[0]!)
    const before = JSON.stringify(site), book = yearbook(site)
    expect(JSON.stringify(site)).toBe(before)
    expect(book.counts).toMatchObject({ creations: 1, fitness: 1, photos: 3 })
  })

  it('handles empty publications and malformed, repeated or obsolete year links without inventing content', () => {
    const empty = yearbook(publicSnapshot())
    expect(empty).toEqual({ years: [], unknown: [], counts: { creations: 0, notes: 0, photos: 0, fitness: 0 } })
    expect(yearbookSelection(empty, '2026')).toBe('')
    const book = yearbook(fixture())
    expect(yearbookSelection(book, '2024')).toBe('2024')
    for (const query of ['unknown', '2048', ['2024', '2025'], null, { year: '2024' }]) expect(yearbookSelection(book, query)).toBe('2026')
    const undated = fixture()
    undated.creations[0]!.publishedAt = ''; undated.albums = []; undated.fitness.entries = []
    expect(yearbookSelection(yearbook(undated), 'unknown')).toBe('unknown')
  })

  it('accepts leap days and offset instants but rejects dates whose timezone is unknown', () => {
    expect(yearbookPublishedDate('2024-02-29T16:00:00Z')).toBe('2024-03-01')
    expect(yearbookPublishedDate('2026-01-01T01:00:00+09:00')).toBe('2026-01-01')
    for (const value of ['', '2026-01-01', '2026-01-01T08:00:00', '2025-02-29T00:00:00Z', 'garbage']) expect(yearbookPublishedDate(value)).toBe('')
  })
})
