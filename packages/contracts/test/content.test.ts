import { describe, expect, it } from 'vitest';
import { ContentBlockSchema, CreationDraftSchema, deriveFormats, HERO_TITLE, PublishableCreationSchema, RichTextDocumentSchema, SiteSettingsSchema } from '../src';

const richtext = { id: 'b_text', type: 'richtext', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '固定测试文本，不是生产内容。' }] }] } };
const image = { id: 'b_image', type: 'image', assetId: 'asset_photo', alt: '测试照片的替代文字' };
const audio = { id: 'b_audio', type: 'audio', assetId: 'asset_audio', title: '测试音频' };
const video = { id: 'b_video', type: 'video', assetId: 'asset_video', posterAssetId: 'asset_poster' };
const draft = { title: '契约测试', slug: 'contract-test', kind: 'article', blocks: [richtext, image, audio, video] };

describe('unified mixed-media drafts', () => {
  it('preserves media order and makes one entry discoverable in all relevant format tabs', () => {
    const parsed = CreationDraftSchema.parse(draft);
    expect(parsed.blocks.map(block => block.id)).toEqual(['b_text', 'b_image', 'b_audio', 'b_video']);
    expect(deriveFormats(parsed)).toEqual(['text', 'audio', 'video']);
    expect(deriveFormats(parsed.blocks.slice(2))).toEqual(['audio', 'video']);
    expect(parsed.featured).toBe(false);
    expect(parsed.sortOrder).toBe(0);
    expect(parsed.blocks[2]).toMatchObject({ downloadAllowed: false });
  });

  it('covers every supported block without accepting arbitrary embeds or binary payloads', () => {
    const blocks = [richtext, image, audio, video,
      { id: 'b_gallery', type: 'gallery', items: [{ assetId: 'asset_photo', alt: '图集替代文字' }] },
      { id: 'b_file', type: 'file', assetId: 'asset_pdf', label: '测试附件' },
      { id: 'b_quote', type: 'quote', text: '测试引用', sourceUrl: 'https://example.org/source' },
      { id: 'b_code', type: 'code', language: 'html', code: '<script>alert("example only")</script>' },
    ];
    expect(CreationDraftSchema.parse({ ...draft, blocks }).blocks).toHaveLength(8);
    expect(ContentBlockSchema.safeParse({ ...video, iframe: '<iframe src="https://example.org"/>' }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...image, bytes: [1, 2, 3] }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...image, originalKey: 'private/photo.jpg' }).success).toBe(false);
  });

  it('rejects duplicate block IDs before they can corrupt reordering or references', () => {
    expect(CreationDraftSchema.safeParse({ ...draft, blocks: [image, { ...audio, id: image.id }] }).success).toBe(false);
  });

  it('separates incomplete draft persistence from publication validation', () => {
    const empty = { title: '', slug: '', blocks: [] };
    expect(CreationDraftSchema.safeParse(empty).success).toBe(true);
    expect(PublishableCreationSchema.safeParse(empty).success).toBe(false);
    expect(PublishableCreationSchema.safeParse({ ...draft, blocks: [{ ...richtext, document: { type: 'doc', content: [] } }] }).success).toBe(false);
    expect(PublishableCreationSchema.safeParse(draft).success).toBe(true);
  });

  it('requires exactly one audio/video source and a real video poster reference', () => {
    expect(ContentBlockSchema.safeParse({ ...audio, assetId: undefined }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...audio, providerRef: { provider: 'tencent', contentId: '123' } }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...video, posterAssetId: undefined }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...audio, assetId: undefined, providerRef: { provider: 'tencent', contentId: 'https://evil.example/stream' } }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...audio, autoplay: true }).success).toBe(false);
  });

  it('enforces the UTF-8 aggregate body limit beyond individual block limits', () => {
    const blocks = Array.from({ length: 8 }, (_, index) => ({ id: `b_${index}`, type: 'code', language: 'txt', code: '中'.repeat(12_000) }));
    expect(CreationDraftSchema.safeParse({ ...draft, blocks }).success).toBe(false);
  });
});

describe('rich text and settings security boundaries', () => {
  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '//evil.example/path', 'https://user:password@example.org', '/%2f%2fevil.example', '/\\evil.example', 'java\nscript:alert(1)'])('rejects unsafe link %s', href => {
    const document = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '测试链接', marks: [{ type: 'link', attrs: { href } }] }] }] };
    expect(RichTextDocumentSchema.safeParse(document).success).toBe(false);
  });

  it('accepts safe links and nested lists while preserving spaces around emphasis', () => {
    const document = { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'before ' }, { type: 'text', text: 'bold', marks: [{ type: 'bold' }] }, { type: 'text', text: ' after', marks: [{ type: 'link', attrs: { href: '/creations/test' } }] }] },
      { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'child' }] }] }] },
    ] }] }] };
    expect(RichTextDocumentSchema.parse(document)).toEqual(document);
  });

  it('rejects raw HTML, arbitrary attributes, deep and cyclic trees without recursion overflow', () => {
    expect(RichTextDocumentSchema.safeParse({ type: 'doc', content: [{ type: 'html', html: '<img onerror=alert(1)>' }] }).success).toBe(false);
    expect(RichTextDocumentSchema.safeParse({ type: 'doc', content: [{ type: 'paragraph', attrs: { onclick: 'alert(1)' }, content: [] }] }).success).toBe(false);
    let deep: unknown = { type: 'paragraph', content: [] };
    for (let i = 0; i < 30; i++) deep = { type: 'bulletList', content: [{ type: 'listItem', content: [deep] }] };
    expect(RichTextDocumentSchema.safeParse({ type: 'doc', content: [deep] }).success).toBe(false);
    const cyclic: { type: string; content: unknown[] } = { type: 'doc', content: [] }; cyclic.content.push(cyclic);
    expect(RichTextDocumentSchema.safeParse(cyclic).success).toBe(false);
  });

  it('preserves the exact agreed Unicode title and refuses older spellings', () => {
    expect(SiteSettingsSchema.parse({}).heroTitle).toBe(HERO_TITLE);
    expect(SiteSettingsSchema.safeParse({ heroTitle: "Hello! I'm 虚宁" }).success).toBe(false);
    expect(SiteSettingsSchema.safeParse({ secret: 'must never be public' }).success).toBe(false);
  });
});
