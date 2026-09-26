import { describe, expect, it } from 'vitest';
import { appendReadyPhotos, applyPhotoMetadata } from '../src/photo-selection';
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
});
