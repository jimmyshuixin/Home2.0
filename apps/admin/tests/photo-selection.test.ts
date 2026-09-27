import { describe, expect, it } from 'vitest';
import { appendReadyPhotos, applyPhotoMetadata, replacePhotoAsset } from '../src/photo-selection';
import { providerContentId } from '../src/provider-input';
import type { MediaItem } from '../src/api';
const image = (id: string, status = 'ready'): MediaItem => ({ id, kind: 'image', status, originalName: `${id}.jpg`, originalBytes: 100, variants: [], metadata: { photography: { takenDate: '2026-08-23' } } });
describe('batch photo association', () => {
  it('only appends ready unique photos within capacity and preserves order and EXIF date', () => {
    const photos = appendReadyPhotos([], [image('first'), image('pending', 'processing'), image('first'), image('second'), image('third')], 2);
    expect(photos.map(photo => photo.assetId)).toEqual(['first', 'second']);
    expect(photos.map(photo => photo.sortOrder)).toEqual([0, 1]);
    expect(photos.every(photo => photo.status === 'draft' && photo.photoDate === '2026-08-23')).toBe(true);
    expect(appendReadyPhotos(photos, [image('first')], 100)).toEqual(photos);
  });
  it('does not replace manually entered photo dates or descriptions', () => {
    const photo = appendReadyPhotos([], [image('photo')], 1)[0]!;
    photo.photoDate = '2025-01-01'; photo.alt = 'Manual description'; applyPhotoMetadata(photo, image('replacement'));
    expect(photo.photoDate).toBe('2025-01-01'); expect(photo.alt).toBe('Manual description');
    photo.photoDate = null; applyPhotoMetadata(photo, { ...image('replacement'), metadata: {} }); expect(photo.photoDate).toBeNull();
  });
});
describe('provider link normalization', () => {
  it('accepts full BiliBili and YouTube links without network resolution', () => {
    expect(providerContentId('bilibili', 'https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333')).toBe('BV1xx411c7mD');
    expect(providerContentId('youtube', 'https://youtu.be/dQw4w9WgXc?t=4')).toBe('dQw4w9WgXc');
    expect(providerContentId('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXc')).toBe('dQw4w9WgXc');
    expect(providerContentId('netease', 'https://music.163.com/#/song?id=123')).toBe('123');
  });
  it('does not turn unsupported hosts, protocols or credentialed URLs into trusted IDs', () => {
    for (const value of ['https://bilibili.com.evil.test/video/BV1xx411c7mD', 'http://www.bilibili.com/video/BV1xx411c7mD', 'https://user@www.bilibili.com/video/BV1xx411c7mD', 'javascript:alert(1)']) expect(providerContentId('bilibili', value)).toBe(value);
  });
  it('extracts Douyin IDs from exact public video paths without fetching short links', () => {
    expect(providerContentId('douyin', 'https://www.douyin.com/video/7661639577056136457?previous_page=web_code_link')).toBe('7661639577056136457');
    expect(providerContentId('douyin', '7661639577056136457')).toBe('7661639577056136457');
    for (const value of ['https://v.douyin.com/share-token/', 'https://www.douyin.com.evil.invalid/video/7661639577056136457', 'https://user@www.douyin.com/video/7661639577056136457', 'https://www.douyin.com/video/7661639577056136457/extra', 'https://www.douyin.com/user/7661639577056136457', 'https://www.douyin.com/video/123', 'http://www.douyin.com/video/7661639577056136457']) expect(providerContentId('douyin', value)).toBe(value);
  });
  it('keeps new photography locations private even when the source image has GPS', () => {
    const located = { ...image('with-gps'), metadata: { gps: { latitude: 31.82, longitude: 117.23 } } };
    const photo = appendReadyPhotos([], [located], 1, true)[0]!;
    expect(photo.map).toEqual({ visibility: 'hidden', source: 'exif' });
    expect(JSON.stringify(photo)).not.toContain('31.82');
    expect(appendReadyPhotos([], [located], 1)[0]).not.toHaveProperty('map');
  });
  it('clears all prior location data on image replacement while preserving manual dates and descriptions', () => {
    const photo = appendReadyPhotos([], [image('original')], 1, true)[0]!;
    photo.photoDate = '2025-01-01'; photo.alt = 'Manual description';
    photo.map = { visibility: 'city', source: 'manual', coordinates: { latitude: 31.123, longitude: 117.456 }, label: 'Private place', cityLabel: '合肥', city: { latitude: 31.82, longitude: 117.23, label: '合肥' } };
    replacePhotoAsset(photo, 'replacement', true); applyPhotoMetadata(photo, image('replacement'));
    expect(photo.assetId).toBe('replacement');
    expect(photo.map).toEqual({ visibility: 'hidden', source: 'exif' });
    expect(photo.photoDate).toBe('2025-01-01'); expect(photo.alt).toBe('Manual description');
  });
  it('does not discard location when the same image is selected again', () => {
    const photo = appendReadyPhotos([], [image('same')], 1, true)[0]!;
    photo.map = { visibility: 'exact', source: 'manual', coordinates: { latitude: 0, longitude: 0 } };
    replacePhotoAsset(photo, 'same', true);
    expect(photo.map).toEqual({ visibility: 'exact', source: 'manual', coordinates: { latitude: 0, longitude: 0 } });
  });
  it('does not add map settings to fitness images when replacing or clearing their asset', () => {
    const photo = appendReadyPhotos([], [image('fitness')], 1)[0]!;
    replacePhotoAsset(photo, 'next');
    expect(photo).not.toHaveProperty('map');
    replacePhotoAsset(photo, null);
    expect(photo.assetId).toBe(''); expect(photo).not.toHaveProperty('map');
  });
});
