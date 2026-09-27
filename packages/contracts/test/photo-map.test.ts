import { describe, expect, it } from 'vitest';
import { AlbumDraftSchema, AlbumPhotoSchema, FitnessPhotoDraftSchema, PhotoCoordinatesSchema, PhotoMapSettingsSchema, PublicPhotoLocationSchema } from '../src';

describe('private photo choices and public map positions', () => {
  const photo = { id: 'photo', assetId: 'asset', alt: 'Photo', status: 'published' };
  it('keeps old albums valid and defaults an explicit new map choice to hidden', () => {
    expect(AlbumDraftSchema.parse({ photos: [photo] }).photos[0]).not.toHaveProperty('map');
    expect(PhotoMapSettingsSchema.parse({})).toEqual({ visibility: 'hidden', source: 'exif' });
    expect(AlbumPhotoSchema.parse(photo)).not.toHaveProperty('location');
  });
  it('persists incomplete private city/manual choices without permitting them in a public photo', () => {
    for (const map of [{ visibility: 'city' }, { visibility: 'exact', source: 'manual' }, { visibility: 'city', city: { latitude: 30, longitude: 120, label: '' } }]) {
      const draft = AlbumDraftSchema.parse({ photos: [{ ...photo, map }] });
      expect(draft.photos[0]).toHaveProperty('map');
      expect(AlbumPhotoSchema.safeParse(draft.photos[0]).success).toBe(false);
    }
    expect(FitnessPhotoDraftSchema.safeParse({ ...photo, map: {} }).success).toBe(false);
  });
  it('accepts only finite geographic coordinates, including genuine zero and boundary points', () => {
    for (const coordinates of [{ latitude: 0, longitude: 0 }, { latitude: -90, longitude: 180 }, { latitude: 90, longitude: -180 }]) expect(PhotoCoordinatesSchema.safeParse(coordinates).success).toBe(true);
    for (const coordinates of [{ latitude: NaN, longitude: 1 }, { latitude: Infinity, longitude: 1 }, { latitude: 91, longitude: 1 }, { latitude: 1, longitude: -181 }, { latitude: '30', longitude: 120 }]) expect(PhotoCoordinatesSchema.safeParse(coordinates).success).toBe(false);
  });
  it('requires the public city label and refuses private source or GPS in public positions', () => {
    const city = { latitude: 30, longitude: 120, precision: 'city', label: 'Chosen city' };
    expect(PublicPhotoLocationSchema.safeParse(city).success).toBe(true);
    expect(PublicPhotoLocationSchema.safeParse({ ...city, label: '' }).success).toBe(false);
    expect(PublicPhotoLocationSchema.safeParse({ ...city, source: 'exif' }).success).toBe(false);
    expect(AlbumPhotoSchema.safeParse({ ...photo, location: city, map: { visibility: 'hidden' } }).success).toBe(false);
    expect(AlbumDraftSchema.safeParse({ photos: [{ ...photo, location: city }] }).success).toBe(false);
  });
});
