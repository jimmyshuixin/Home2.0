import { describe, expect, it } from 'vitest'
import { photoMapEntries, type MapAlbum } from '../lib/photo-map'

const album = (): MapAlbum => ({ id: 'series', title: 'Test series', slug: 'test-series', photos: [
  { id: 'exact', assetId: 'image', alt: 'Test photo', status: 'published', location: { latitude: 0, longitude: 0, precision: 'exact' } },
  { id: 'city', assetId: 'another', alt: 'City photo', status: 'published', location: { latitude: -33, longitude: -70, precision: 'city', label: 'City' } },
] })
describe('public photography map selection', () => {
  it('keeps valid equator and southern/western positions with their published precision', () => {
    expect(photoMapEntries([album()]).map(entry => entry.location)).toEqual(album().photos.map(photo => photo.location))
  })
  it('does not place draft, hidden, absent, or invalid locations', () => {
    const item = album()
    item.photos[0]!.status = 'hidden'
    item.photos[1]!.status = 'draft'
    item.photos.push({ id: 'no-place', assetId: 'third', alt: 'No place', status: 'published' })
    item.photos.push({ id: 'bad-place', assetId: 'fourth', alt: 'Bad place', status: 'published', location: { latitude: NaN, longitude: 120, precision: 'exact' } })
    expect(photoMapEntries([item])).toEqual([])
  })
  it('keeps each album reference independent even when it reuses the same asset', () => {
    const first = album(), second = { ...album(), id: 'second' }
    expect(photoMapEntries([first, second]).map(entry => entry.key)).toEqual(['series/exact', 'series/city', 'second/exact', 'second/city'])
  })
  it('ignores duplicate photo references in the same album', () => {
    const item = album(); item.photos.push(item.photos[0]!)
    expect(photoMapEntries([item])).toHaveLength(2)
  })
})
