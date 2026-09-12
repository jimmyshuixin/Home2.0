import { describe, expect, it } from 'vitest';
import { AlbumDraftSchema, canReserveMediaBytes, CommentInputSchema, ContactInputSchema, DetectedMediaMetadataSchema, FitnessEntryDraftSchema, MEDIA_LIMITS, PlaylistDraftSchema, PublicMediaAssetSchema, UploadMetadataSchema } from '../src';

describe('media declarations and quota boundary', () => {
  const video = { kind: 'video', originalName: '测试视频.mp4', expectedMime: 'video/mp4', expectedBytes: 512_000_000 };
  it('uses the confirmed decimal 512 MB limit rather than the superseded 1 GB or 512 MiB', () => {
    expect(UploadMetadataSchema.safeParse(video).success).toBe(true);
    expect(UploadMetadataSchema.safeParse({ ...video, expectedBytes: 512_000_001 }).success).toBe(false);
    expect(UploadMetadataSchema.safeParse({ ...video, expectedBytes: 512 * 1024 * 1024 }).success).toBe(false);
    expect(UploadMetadataSchema.safeParse({ ...video, expectedBytes: 1_000_000_000 }).success).toBe(false);
    expect(UploadMetadataSchema.safeParse({ ...video, expectedBytes: '512000000' }).success).toBe(false);
  });

  it('rejects active file types and path-like names, including a disguised MIME/kind', () => {
    expect(UploadMetadataSchema.safeParse({ ...video, originalName: '../other/video.mp4' }).success).toBe(false);
    expect(UploadMetadataSchema.safeParse({ ...video, originalName: 'C:\\private\\video.mp4' }).success).toBe(false);
    expect(UploadMetadataSchema.safeParse({ ...video, expectedMime: 'text/html' }).success).toBe(false);
    expect(UploadMetadataSchema.safeParse({ kind: 'image', originalName: 'image.svg', expectedMime: 'image/svg+xml', expectedBytes: 100 }).success).toBe(false);
    expect(UploadMetadataSchema.safeParse({ kind: 'image', originalName: 'fake.jpg', expectedMime: 'video/mp4', expectedBytes: 100 }).success).toBe(false);
  });

  it('accounts for in-flight reservations at the total 10 GB boundary', () => {
    expect(canReserveMediaBytes(9_000_000_000, 488_000_000, 512_000_000)).toBe(true);
    expect(canReserveMediaBytes(9_000_000_000, 488_000_001, 512_000_000)).toBe(false);
    expect(canReserveMediaBytes(MEDIA_LIMITS.totalBytes, 0, 1)).toBe(false);
    expect(canReserveMediaBytes(-1, 0, 1)).toBe(false);
    expect(canReserveMediaBytes(0, 0, NaN)).toBe(false);
    expect(canReserveMediaBytes(0, 0, 0)).toBe(false);
  });

  it('rejects a decoded image exceeding the pixel ceiling even if its compressed byte size is small', () => {
    const decoded = { kind: 'image', detectedMime: 'image/png', bytes: 100, sha256: 'a'.repeat(64), width: 6000, height: 6000 };
    expect(DetectedMediaMetadataSchema.safeParse(decoded).success).toBe(true);
    expect(DetectedMediaMetadataSchema.safeParse({ ...decoded, height: 6001 }).success).toBe(false);
  });

  it('keeps private storage fields out of public projections', () => {
    const asset = { id: 'asset_1', kind: 'image', variants: [{ role: 'content', url: '/media/hash.webp', mime: 'image/webp', bytes: 200, width: 10, height: 20 }] };
    expect(PublicMediaAssetSchema.safeParse(asset).success).toBe(true);
    expect(PublicMediaAssetSchema.safeParse({ ...asset, originalKey: 'private/original.jpg' }).success).toBe(false);
    expect(PublicMediaAssetSchema.safeParse({ ...asset, originalName: 'private-name.jpg' }).success).toBe(false);
    expect(PublicMediaAssetSchema.safeParse({ ...asset, variants: [{ ...asset.variants[0], objectKey: 'private/object' }] }).success).toBe(false);
  });
});

describe('anonymous submissions and other draft models', () => {
  it('permits anonymous comments while rejecting client-assigned moderation or identity', () => {
    expect(CommentInputSchema.parse({ targetType: 'guestbook', body: '测试留言' })).toMatchObject({ nickname: '', targetId: null });
    expect(CommentInputSchema.safeParse({ targetType: 'guestbook', body: '测试留言', moderationStatus: 'approved' }).success).toBe(false);
    expect(CommentInputSchema.safeParse({ targetType: 'creation', body: '测试留言' }).success).toBe(false);
    expect(CommentInputSchema.safeParse({ targetType: 'guestbook', targetId: 'home', body: '测试留言' }).success).toBe(false);
  });

  it('enforces 30/500 Unicode-character limits and refuses markup/honeypot data', () => {
    const input = { targetType: 'guestbook', nickname: '😀'.repeat(30), body: '中'.repeat(500), website: '', startedAt: 1_700_000_000_000 };
    expect(CommentInputSchema.safeParse(input).success).toBe(true);
    expect(CommentInputSchema.safeParse({ ...input, nickname: '😀'.repeat(31) }).success).toBe(false);
    expect(CommentInputSchema.safeParse({ ...input, body: '中'.repeat(501) }).success).toBe(false);
    expect(CommentInputSchema.safeParse({ ...input, body: '<script>alert(1)</script>' }).success).toBe(false);
    expect(CommentInputSchema.safeParse({ ...input, website: 'https://spam.example' }).success).toBe(false);
  });

  it('does not mix contact private messages with public-comment fields', () => {
    expect(ContactInputSchema.safeParse({ nickname: '测试', email: 'test@example.org', message: '固定测试私信' }).success).toBe(true);
    expect(ContactInputSchema.safeParse({ nickname: '测试', email: 'bad address', message: '固定测试私信' }).success).toBe(false);
    expect(ContactInputSchema.safeParse({ nickname: '测试', email: 'test@example.org', message: '固定测试私信', targetType: 'guestbook' }).success).toBe(false);
  });

  it('keeps unknown photo dates null and preserves explicit independent ordering', () => {
    const album = AlbumDraftSchema.parse({ title: '测试相册', slug: 'test-album', photos: [
      { id: 'photo_1', assetId: 'asset_1', alt: '第一张测试照片', sortOrder: 2 },
      { id: 'photo_2', assetId: 'asset_2', alt: '第二张测试照片', sortOrder: 1, photoDate: '2024-02-29' },
    ] });
    expect(album.photos[0]).toMatchObject({ photoDate: null, sortOrder: 2, status: 'draft' });
    expect(album.photos[1]).toMatchObject({ photoDate: '2024-02-29', sortOrder: 1 });
  });

  it('requires explicit photo visibility and never assigns training labels to real entries', () => {
    const entry = FitnessEntryDraftSchema.parse({ entryDate: '2024-02-29', photos: [
      { id: 'one', assetId: 'asset_one', alt: '测试一' },
      { id: 'two', assetId: 'asset_two', alt: '测试二', status: 'published' },
      { id: 'three', assetId: 'asset_three', alt: '测试三', status: 'hidden' },
    ] });
    expect(entry.tags).toEqual([]);
    expect(entry.photos.map(photo => photo.status)).toEqual(['draft', 'published', 'hidden']);
    expect(FitnessEntryDraftSchema.safeParse({ ...entry, tags: ['训练', '训练'] }).success).toBe(false);
    expect(FitnessEntryDraftSchema.safeParse({ ...entry, photos: [{ ...entry.photos[0], status: 'public' }] }).success).toBe(false);
  });

  it('keeps playlist references stable and excludes temporary playback URLs or account cookies', () => {
    const playlist = { name: '测试歌单', source: 'tencent', sourceId: '123', tracks: [] };
    expect(PlaylistDraftSchema.safeParse(playlist).success).toBe(true);
    expect(PlaylistDraftSchema.safeParse({ ...playlist, sourceId: null }).success).toBe(false);
    expect(PlaylistDraftSchema.safeParse({ ...playlist, cookie: 'private' }).success).toBe(false);
    expect(PlaylistDraftSchema.safeParse({ ...playlist, tracks: [{ id: 'track_1', title: '测试曲目', url: 'https://temporary.example/song.mp3' }] }).success).toBe(false);
  });
});
