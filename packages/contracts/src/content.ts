import { z } from 'zod';
import { boundedTreeProblem, HttpsUrlSchema, IdSchema, jsonByteLength, plainText, requireUniqueIds, SafeHrefSchema, SlugSchema, SortOrderSchema, VersionSchema } from './common';
import { CONTENT_LIMITS, SCHEMA_VERSION } from './limits';

export const RichTextMarkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bold') }).strict(),
  z.object({ type: z.literal('italic') }).strict(),
  z.object({ type: z.literal('strike') }).strict(),
  z.object({ type: z.literal('code') }).strict(),
  z.object({ type: z.literal('link'), attrs: z.object({ href: SafeHrefSchema, title: plainText(120).optional() }).strict() }).strict(),
]);
export type RichTextMark = z.infer<typeof RichTextMarkSchema>;
export const RichInlineSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: plainText(32_000, 1, false), marks: z.array(RichTextMarkSchema).max(5).optional() }).strict(),
  z.object({ type: z.literal('hardBreak') }).strict(),
]);
export type RichInline = z.infer<typeof RichInlineSchema>;
export interface RichParagraph { type: 'paragraph'; content: RichInline[] }
export interface RichHeading { type: 'heading'; attrs: { level: number }; content: RichInline[] }
export interface RichListItem { type: 'listItem'; content: Array<RichParagraph | RichList> }
export type RichList = { type: 'bulletList'; content: RichListItem[] } | { type: 'orderedList'; attrs?: { start: number }; content: RichListItem[] };
export interface RichTextDocument { type: 'doc'; content: Array<RichParagraph | RichHeading | RichList> }

export const RichParagraphSchema: z.ZodType<RichParagraph> = z.object({
  type: z.literal('paragraph'), content: z.array(RichInlineSchema).max(500).default([]),
}).strict();
export const RichHeadingSchema: z.ZodType<RichHeading> = z.object({
  type: z.literal('heading'), attrs: z.object({ level: z.number().int().min(1).max(6) }).strict(),
  content: z.array(RichInlineSchema).max(100),
}).strict();
const RichListItemSchema: z.ZodType<RichListItem> = z.lazy(() => z.object({
  type: z.literal('listItem'), content: z.array(z.union([RichParagraphSchema, RichListSchema])).min(1).max(50),
}).strict());
export const RichListSchema: z.ZodType<RichList> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('bulletList'), content: z.array(RichListItemSchema).min(1).max(100) }).strict(),
  z.object({ type: z.literal('orderedList'), attrs: z.object({ start: z.number().int().min(1).max(10000) }).strict().optional(), content: z.array(RichListItemSchema).min(1).max(100) }).strict(),
]));

export const RichTextDocumentSchema: z.ZodType<RichTextDocument> = z.preprocess((input, ctx) => {
  const problem = boundedTreeProblem(input);
  if (problem) { ctx.addIssue({ code: 'custom', message: problem }); return z.NEVER; }
  return input;
}, z.object({
  type: z.literal('doc'),
  content: z.array(z.union([RichParagraphSchema, RichHeadingSchema, RichListSchema])).max(1000),
}).strict());

/** Provider names are fixed. Resolvers must also enforce provider-specific allowed hosts. */
export const ProviderRefSchema = z.object({
  provider: z.enum(['tencent', 'netease', 'bilibili', 'youtube']),
  contentId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u),
}).strict();
export type ProviderRef = z.infer<typeof ProviderRefSchema>;

const blockId = { id: IdSchema };
export const RichTextBlockSchema = z.object({ ...blockId, type: z.literal('richtext'), document: RichTextDocumentSchema }).strict();
export const ImageBlockSchema = z.object({
  ...blockId, type: z.literal('image'), assetId: IdSchema,
  variantRole: z.enum(['thumb', 'content', 'large']).default('content'),
  alt: plainText(500, 1), caption: plainText(1000).optional(),
  alignment: z.enum(['left', 'center', 'wide']).optional(),
}).strict();
export const GalleryItemSchema = z.object({
  assetId: IdSchema, alt: plainText(500, 1), caption: plainText(1000).optional(), sortOrder: SortOrderSchema,
}).strict();
export const GalleryBlockSchema = z.object({
  ...blockId, type: z.literal('gallery'), items: z.array(GalleryItemSchema).min(1).max(100),
  layout: z.enum(['grid', 'columns', 'stack']).default('grid'),
}).strict();

const mediaSource = { assetId: IdSchema.optional(), providerRef: ProviderRefSchema.optional() };
function oneMediaSource(value: { assetId?: string; providerRef?: ProviderRef }, ctx: z.RefinementCtx) {
  if (Boolean(value.assetId) === Boolean(value.providerRef)) {
    ctx.addIssue({ code: 'custom', path: ['assetId'], message: '必须且只能提供 assetId 或 providerRef 之一' });
  }
}
export const AudioBlockSchema = z.object({
  ...blockId, type: z.literal('audio'), ...mediaSource,
  title: plainText(120, 1), artist: plainText(120).optional(), coverAssetId: IdSchema.optional(),
  transcript: plainText(32_000, 0, false).optional(), downloadAllowed: z.boolean().default(false),
}).strict().superRefine(oneMediaSource);
export const VideoBlockSchema = z.object({
  ...blockId, type: z.literal('video'), ...mediaSource, posterAssetId: IdSchema,
  captionsAssetId: IdSchema.optional(), transcript: plainText(32_000, 0, false).optional(),
  aspectRatio: z.number().positive().max(10).optional(),
}).strict().superRefine(oneMediaSource);
export const FileBlockSchema = z.object({
  ...blockId, type: z.literal('file'), assetId: IdSchema, label: plainText(120, 1), description: plainText(1000).optional(),
}).strict();
export const QuoteBlockSchema = z.object({
  ...blockId, type: z.literal('quote'), text: plainText(5000, 1, false), attribution: plainText(300).optional(), sourceUrl: HttpsUrlSchema.optional(),
}).strict();
export const CodeBlockSchema = z.object({
  ...blockId, type: z.literal('code'), language: z.string().regex(/^[a-z0-9_+-]{1,30}$/u),
  // Code is intentionally literal and can contain HTML examples. Never execute or use innerHTML.
  code: z.string().min(1).max(64_000), filename: plainText(200).optional(),
}).strict();
export const ContentBlockSchema = z.discriminatedUnion('type', [
  RichTextBlockSchema, ImageBlockSchema, GalleryBlockSchema, AudioBlockSchema,
  VideoBlockSchema, FileBlockSchema, QuoteBlockSchema, CodeBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

// Drafts retain unfinished fields as empty strings. Non-empty references still
// use the same allowlists, while publication keeps the complete schemas above.
export const DraftAssetIdSchema = z.union([z.literal(''), IdSchema]).default('');
export const DraftProviderRefSchema = ProviderRefSchema.extend({ contentId: z.union([z.literal(''), ProviderRefSchema.shape.contentId]).default('') });
export function atMostOneMediaSource(value: { assetId?: string; providerRef?: ProviderRef }, ctx: z.RefinementCtx) {
  if (value.assetId && value.providerRef) ctx.addIssue({ code: 'custom', path: ['assetId'], message: '媒体只能选择本站文件或外部平台其中一种来源' });
}
const draftMediaSource = { assetId: DraftAssetIdSchema.optional(), providerRef: DraftProviderRefSchema.optional() };
export const DraftContentBlockSchema = z.discriminatedUnion('type', [
  RichTextBlockSchema,
  ImageBlockSchema.extend({ assetId: DraftAssetIdSchema, alt: plainText(500).default('') }),
  GalleryBlockSchema.extend({ items: z.array(GalleryItemSchema.extend({ assetId: DraftAssetIdSchema, alt: plainText(500).default('') })).max(100).default([]) }),
  z.object({ ...AudioBlockSchema.shape, ...draftMediaSource, title: plainText(120).default('') }).strict().superRefine(atMostOneMediaSource),
  z.object({ ...VideoBlockSchema.shape, ...draftMediaSource, posterAssetId: DraftAssetIdSchema }).strict().superRefine(atMostOneMediaSource),
  FileBlockSchema.extend({ assetId: DraftAssetIdSchema, label: plainText(120).default('') }),
  QuoteBlockSchema.extend({ text: plainText(5000, 0, false).default('') }),
  CodeBlockSchema.extend({ language: z.union([z.literal(''), CodeBlockSchema.shape.language]).default(''), code: z.string().max(64_000).default('') }),
]);

export const CreationFormatSchema = z.enum(['text', 'audio', 'video']);
export type CreationFormat = z.infer<typeof CreationFormatSchema>;
export const CreationKindSchema = z.enum(['article', 'project', 'mixed']);
const creationShape = {
  kind: CreationKindSchema.default('mixed'),
  title: plainText(CONTENT_LIMITS.titleCharacters).default(''),
  slug: z.union([z.literal(''), SlugSchema]).default(''),
  summary: plainText(CONTENT_LIMITS.summaryCharacters).default(''),
  coverAssetId: IdSchema.nullable().optional(),
  tags: z.array(plainText(40, 1)).max(CONTENT_LIMITS.tags).default([]),
  blocks: z.array(DraftContentBlockSchema).max(CONTENT_LIMITS.blocks).default([]),
  seo: z.object({ title: plainText(120).optional(), description: plainText(300).optional() }).strict().default({}),
  sourceLinks: z.array(HttpsUrlSchema).max(20).default([]),
  featured: z.boolean().default(false),
  sortOrder: SortOrderSchema,
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
};

function validateCreation(value: { blocks: ContentBlock[]; tags: string[] }, ctx: z.RefinementCtx) {
  requireUniqueIds(value.blocks, ctx, ['blocks']);
  if (new Set(value.tags).size !== value.tags.length) ctx.addIssue({ code: 'custom', path: ['tags'], message: '标签不可重复' });
  if (jsonByteLength(value) > CONTENT_LIMITS.jsonBytes) ctx.addIssue({ code: 'custom', message: '创作 JSON 不得超过 256 KiB' });
}
export const CreationDraftSchema = z.object(creationShape).strict().superRefine(validateCreation);
export const CreationSaveInputSchema = z.object({ ...creationShape, expectedVersion: VersionSchema }).strict().superRefine(validateCreation);
export const PublishableCreationSchema = z.object({ ...creationShape, blocks: z.array(ContentBlockSchema).max(CONTENT_LIMITS.blocks).default([]) }).strict().superRefine(validateCreation).superRefine((value, ctx) => {
  if (!value.title) ctx.addIssue({ code: 'custom', path: ['title'], message: '发布前请填写标题' });
  if (!value.slug) ctx.addIssue({ code: 'custom', path: ['slug'], message: '发布前请填写 slug' });
  const hasBody = value.blocks.some(block => {
    if (block.type === 'richtext') {
      const stack: unknown[] = [...block.document.content];
      while (stack.length) {
        const node = stack.pop() as { type?: string; text?: string; content?: unknown[] };
        if (node.type === 'text' && node.text?.trim()) return true;
        if (node.content) stack.push(...node.content);
      }
      return false;
    }
    if (block.type === 'code') return Boolean(block.code.trim());
    if (block.type === 'quote') return Boolean(block.text.trim());
    return true;
  });
  if (!hasBody) ctx.addIssue({ code: 'custom', path: ['blocks'], message: '发布前请添加正文内容' });
});
export type CreationDraft = z.infer<typeof CreationDraftSchema>;
export type CreationSaveInput = z.infer<typeof CreationSaveInputSchema>;

/** A mixed entry appears under each matching tab. kind never substitutes for media formats. */
export function deriveFormats(input: readonly ContentBlock[] | Pick<CreationDraft, 'blocks'>): CreationFormat[] {
  const blocks: readonly ContentBlock[] = Array.isArray(input) ? input : (input as Pick<CreationDraft, 'blocks'>).blocks;
  const formats = new Set<CreationFormat>();
  for (const block of blocks) formats.add(block.type === 'audio' ? 'audio' : block.type === 'video' ? 'video' : 'text');
  return (['text', 'audio', 'video'] as const).filter(format => formats.has(format));
}
