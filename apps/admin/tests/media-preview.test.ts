import { describe, expect, it } from 'vitest';
import { previewSource, externalMediaLink, safePreviewLink } from '../src/media';
import type { MediaItem } from '../src/api';
const media = (kind: MediaItem['kind'], roles: string[]): MediaItem => ({ id: 'private-asset', kind, status: 'ready', originalBytes: 512_000_000, variants: roles.map(role => ({ role, url: 'https://untrusted.invalid/public-source' })) });
describe('private administrator media previews', () => {
  it('uses authenticated variants and never trusts a public URL or the original large file', () => {
    expect(previewSource(media('video', ['poster', 'playback']))).toBe('/api/v1/admin/media/private-asset/playback');
    expect(previewSource(media('audio', ['download', 'playback']))).toBe('/api/v1/admin/media/private-asset/playback');
    expect(previewSource(media('video', ['poster']))).toBeUndefined();
    expect(previewSource({ ...media('video', ['playback']), status: 'processing' })).toBeUndefined();
  });
  it('prefers a small thumbnail in lists and a content image when editing', () => {
    const image = media('image', ['content', 'thumb']);
    expect(previewSource(image, true)).toMatch(/\/thumb$/);
    expect(previewSource(image)).toMatch(/\/content$/);
  });
  it('encodes provider IDs and excludes unsupported protocols from draft links', () => {
    expect(externalMediaLink({ provider: 'tencent', contentId: 'song/id?query' })).toBe('https://y.qq.com/n/ryqq/songDetail/song%2Fid%3Fquery');
    expect(externalMediaLink({ provider: 'unknown', contentId: 'id' })).toBeUndefined();
    expect(externalMediaLink({ provider: 'douyin', contentId: '7661639577056136457' })).toBe('https://www.douyin.com/video/7661639577056136457');
    expect(safePreviewLink('javascript:alert(1)')).toBeUndefined();
    expect(safePreviewLink('data:text/html,hello')).toBeUndefined();
    expect(safePreviewLink('/creations/example')).toBe('https://xvyin.com/creations/example');
  });
});
