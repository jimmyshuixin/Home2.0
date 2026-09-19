import { describe, expect, it } from 'vitest';
import { AlbumDraftSchema, CreationDraftSchema, FitnessEntryDraftSchema, PlaylistDraftSchema, PublishableAlbumSchema, PublishableCreationSchema, PublishableFitnessEntrySchema, PublishablePlaylistSchema } from '../src';

const partialBlocks = [
  { id: 'image', type: 'image' }, { id: 'gallery', type: 'gallery', items: [{ assetId: '', alt: '' }] },
  { id: 'empty_gallery', type: 'gallery', items: [] }, { id: 'audio', type: 'audio', assetId: '' },
  { id: 'video', type: 'video', providerRef: { provider: 'bilibili', contentId: '' } },
  { id: 'quote', type: 'quote', text: '' }, { id: 'code', type: 'code', code: '' }, { id: 'file', type: 'file', assetId: '' },
];

describe('incomplete drafts and complete publication are distinct boundaries', () => {
  it('publishes external video/audio and playlist drafts with legacy empty asset sentinels', () => {
    const draft = CreationDraftSchema.parse({ title: 'External media', slug: 'external-media', blocks: [
      { id: 'external_video', type: 'video', assetId: '', posterAssetId: '', providerRef: { provider: 'bilibili', contentId: 'BV1xx411c7mD' } },
      { id: 'external_audio', type: 'audio', assetId: '', title: 'Music', providerRef: { provider: 'netease', contentId: '123' } },
    ] });
    const published = PublishableCreationSchema.parse(draft);
    expect(published.blocks[0]).toMatchObject({ providerRef: { provider: 'bilibili', contentId: 'BV1xx411c7mD' } });
    expect(JSON.stringify(published)).not.toContain('"assetId":""');
    expect(CreationDraftSchema.parse({ blocks: [{ id: 'new_video', type: 'video', providerRef: { provider: 'bilibili', contentId: 'BV1xx411c7mD' } }] }).blocks[0]).not.toHaveProperty('assetId');
    const playlist = PlaylistDraftSchema.parse({ name: 'External track', tracks: [{ id: 'track', title: 'Music', assetId: '', providerRef: { provider: 'tencent', contentId: '123' } }] });
    expect(PublishablePlaylistSchema.safeParse(playlist).success).toBe(true);
    expect(PublishableCreationSchema.safeParse({ ...draft, blocks: [{ id: 'local', type: 'video', assetId: 'local_asset', posterAssetId: '' }] }).success).toBe(false);
    expect(PublishableCreationSchema.safeParse({ ...draft, blocks: [{ id: 'missing', type: 'video', assetId: '', posterAssetId: '' }] }).success).toBe(false);
  });
  it.each([
    ['creations', CreationDraftSchema, PublishableCreationSchema, { blocks: partialBlocks }],
    ['albums', AlbumDraftSchema, PublishableAlbumSchema, { photos: [{ id: 'photo' }] }],
    ['fitness', FitnessEntryDraftSchema, PublishableFitnessEntrySchema, { photos: [{ id: 'photo', status: 'published' }] }],
    ['playlists', PlaylistDraftSchema, PublishablePlaylistSchema, { source: 'tencent', tracks: [{ id: 'track', providerRef: { provider: 'tencent', contentId: '' } }] }],
  ] as const)('preserves unfinished %s fields without satisfying publication', (_collection, draftSchema, publishSchema, input) => {
    const draft = draftSchema.parse(input);
    expect(draftSchema.parse(draft)).toEqual(draft);
    expect(publishSchema.safeParse(draft).success).toBe(false);
  });

  it('retains ordering and selected source modes in empty mixed-media blocks', () => {
    const draft = CreationDraftSchema.parse({ blocks: partialBlocks });
    expect(draft.blocks.map(block => block.id)).toEqual(partialBlocks.map(block => block.id));
    expect(draft.blocks[0]).toMatchObject({ assetId: '', alt: '' });
    expect(draft.blocks[4]).toMatchObject({ providerRef: { provider: 'bilibili', contentId: '' } });
    expect(draft.blocks[4]).not.toHaveProperty('posterAssetId');
    expect(PublishableCreationSchema.safeParse({ ...draft, title: 'Ready title', slug: 'ready-title' }).success).toBe(false);
    expect(FitnessEntryDraftSchema.parse({}).entryDate).toBe('');
    expect(FitnessEntryDraftSchema.parse({ photos: [{ id: 'photo' }] }).photos[0]?.photoDate).toBeNull();
  });

  it.each([
    { id: 'bad/id', type: 'image' },
    { id: 'bad', type: 'image', assetId: '../private' },
    { id: 'bad', type: 'audio', assetId: 'asset', providerRef: { provider: 'tencent', contentId: '' } },
    { id: 'bad', type: 'video', providerRef: { provider: 'bilibili', contentId: 'https://attacker.invalid' } },
    { id: 'bad', type: 'quote', text: '<script>alert(1)</script>' },
    { id: 'bad', type: 'quote', sourceUrl: 'javascript:alert(1)' },
    { id: 'bad', type: 'image', originalKey: 'originals/secret' },
    { id: 'bad', type: 'code', code: 'a'.repeat(64_001) },
  ])('still rejects unsafe or oversized unfinished blocks %#', block => {
    expect(CreationDraftSchema.safeParse({ blocks: [block] }).success).toBe(false);
  });

  it('does not relax duplicate IDs, real calendar dates, music providers or public-required references', () => {
    expect(AlbumDraftSchema.safeParse({ photos: [{ id: 'same' }, { id: 'same' }] }).success).toBe(false);
    expect(FitnessEntryDraftSchema.safeParse({ entryDate: '2026-02-30' }).success).toBe(false);
    expect(PlaylistDraftSchema.safeParse({ tracks: [{ id: 'track', providerRef: { provider: 'youtube', contentId: '' } }] }).success).toBe(false);
    expect(PublishablePlaylistSchema.safeParse({ name: 'Incomplete external playlist', source: 'tencent', sourceId: null }).success).toBe(false);
    expect(PublishableAlbumSchema.safeParse({ title: 'Album', slug: 'album', photos: [{ id: 'photo', status: 'published' }] }).success).toBe(false);
    expect(PublishableFitnessEntrySchema.safeParse({ title: 'Date missing', entryDate: '' }).success).toBe(false);
  });
});
