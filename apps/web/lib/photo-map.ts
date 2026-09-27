import type { Photo } from './models'

export interface MapLocation { latitude: number; longitude: number; precision: 'city' | 'exact'; label?: string }
export interface MapAlbum { id: string; title: string; slug: string; photos: Photo[] }
export interface PhotoMapEntry { key: string; album: MapAlbum; photo: Photo; location: MapLocation }

/** Use only explicitly published photo locations; never infer a place from captions or dates. */
export function photoMapEntries(albums: readonly MapAlbum[]): PhotoMapEntry[] {
  const entries: PhotoMapEntry[] = []
  const seen = new Set<string>()
  for (const album of albums) for (const photo of album.photos) {
    const location = photo.location
    if (photo.status !== 'published' || !photo.id || !location || !['city', 'exact'].includes(location.precision)
      || !Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90
      || !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180) continue
    const key = `${album.id}/${photo.id}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ key, album, photo, location })
  }
  return entries
}
