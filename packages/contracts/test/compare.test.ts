import { describe, expect, it } from 'vitest';
import { ContentBlockSchema, CreationDraftSchema, PublishableCreationSchema, comparisonMediaProblems, deriveFormats, type PublicMediaAsset } from '../src';
const compare = { id: 'comparison', type: 'compare', before: { assetId: 'photo-before', alt: '日出前的山坡', label: '日出前' }, after: { assetId: 'photo-after', alt: '日出后的山坡', label: '日出后' }, caption: '同一机位，不同时刻。' };
const draft = { title: '晨光对比', slug: 'morning-comparison', blocks: [compare] };
const image = (id: string): PublicMediaAsset => ({ id, kind: 'image', variants: [{ role: 'content', mime: 'image/webp', bytes: 42, width: 900, height: 600, url: `/api/v1/media/${id}/content` }] });

describe('image comparison content contract', () => {
  it('saves unfinished comparisons but requires both image references, labels and alternatives for publication', () => {
    const incomplete = { ...draft, blocks: [{ id: 'comparison', type: 'compare' }] };
    expect(CreationDraftSchema.parse(incomplete).blocks[0]).toMatchObject({ before: { assetId: '', alt: '', label: '' }, after: { assetId: '', alt: '', label: '' }, mode: 'side-by-side' });
    expect(PublishableCreationSchema.safeParse(incomplete).success).toBe(false);
    expect(PublishableCreationSchema.parse(draft).blocks[0]).toMatchObject({ mode: 'side-by-side' });
    for (const side of ['before', 'after'] as const) for (const field of ['assetId', 'alt', 'label'] as const) {
      expect(ContentBlockSchema.safeParse({ ...compare, [side]: { ...compare[side], [field]: '' } }).success).toBe(false);
    }
    expect(deriveFormats(PublishableCreationSchema.parse(draft).blocks)).toEqual(['text']);
  });
  it('rejects raw paths, external sources and oversized captions while accepting the explicit slider mode', () => {
    expect(ContentBlockSchema.safeParse({ ...compare, mode: 'slider' }).success).toBe(true);
    for (const unsafe of [{ originalKey: 'private/original.jpg' }, { url: 'https://example.org/image.jpg' }, { gps: { latitude: 1, longitude: 2 } }, { providerRef: { provider: 'bilibili', contentId: 'BV1abc' } }]) {
      expect(ContentBlockSchema.safeParse({ ...compare, before: { ...compare.before, ...unsafe } }).success).toBe(false);
    }
    expect(ContentBlockSchema.safeParse({ ...compare, caption: '长'.repeat(1001) }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...compare, mode: 'autoplay' }).success).toBe(false);
  });
  it('requires projected images with real dimensions, including for assets already public', () => {
    const entries = [CreationDraftSchema.parse(draft)], first = image('photo-before'), second = image('photo-after');
    expect(comparisonMediaProblems(entries, [first, second])).toEqual([]);
    expect(comparisonMediaProblems(entries, [first])).toMatchObject([{ side: 'after' }]);
    expect(comparisonMediaProblems(entries, [first], false)).toEqual([]);
    expect(comparisonMediaProblems(entries, [first, { ...second, kind: 'audio' }], false)).toMatchObject([{ side: 'after' }]);
    expect(comparisonMediaProblems(entries, [first, { ...second, variants: second.variants.map(variant => ({ ...variant, width: undefined })) }])).toMatchObject([{ side: 'after' }]);
  });
  it('supports note creation without loosening body publication checks', () => {
    expect(PublishableCreationSchema.parse({ ...draft, kind: 'note' }).kind).toBe('note');
    expect(CreationDraftSchema.safeParse({ kind: 'note' }).success).toBe(true);
    expect(PublishableCreationSchema.safeParse({ ...draft, kind: 'note', blocks: [] }).success).toBe(false);
  });
});
