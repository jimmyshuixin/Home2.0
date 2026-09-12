import { z } from 'zod';
import { IdSchema, plainText, requireUniqueIds, SlugSchema, SortOrderSchema, UtcTimestampSchema, VersionSchema } from './common';
import { ProviderRefSchema } from './content';
import { CalendarDateSchema, fitnessDayCount } from './dates';
import { CONTENT_LIMITS, FITNESS_TIMEZONE } from './limits';

export const VisibilitySchema = z.enum(['draft', 'published', 'hidden']);
export const ModerationStatusSchema = z.enum(['pending', 'approved', 'rejected', 'hidden']);
const fitnessSettingsDraftShape = {
  startDate: CalendarDateSchema.nullable().default(null),
  timezone: z.literal(FITNESS_TIMEZONE).default(FITNESS_TIMEZONE),
  enabled: z.boolean().default(true),
  intro: plainText(2000).default(''),
};
export const FitnessSettingsDraftSchema = z.object(fitnessSettingsDraftShape).strict();
export const FitnessSettingsSchema = z.object({
  ...fitnessSettingsDraftShape, id: z.literal('default').default('default'),
  version: VersionSchema.default(0), updatedAt: UtcTimestampSchema.optional(),
}).strict();
export const FitnessSettingsInputSchema = z.object({
  ...fitnessSettingsDraftShape,
  // A replacement/save must explicitly preserve, set or clear the date; omission never resets it.
  startDate: CalendarDateSchema.nullable(), expectedVersion: VersionSchema,
}).strict();
export function createFitnessSettingsInputSchema(now: Date | number) {
  return FitnessSettingsInputSchema.superRefine((value, ctx) => {
    try { fitnessDayCount(value.startDate, now); }
    catch (error) {
      ctx.addIssue({ code: 'custom', path: ['startDate'], message: error instanceof Error && 'code' in error ? String(error.code) : 'INVALID_DATE' });
    }
  });
}
export function validateFitnessSettings(input: unknown, now: Date | number) {
  const parsed = FitnessSettingsInputSchema.parse(input);
  fitnessDayCount(parsed.startDate, now);
  return parsed;
}
export type FitnessSettingsDraft = z.infer<typeof FitnessSettingsDraftSchema>;
export type FitnessSettings = z.infer<typeof FitnessSettingsSchema>;
export type FitnessSettingsInput = z.infer<typeof FitnessSettingsInputSchema>;

const photoDraftShape = {
  id: IdSchema, assetId: IdSchema, alt: plainText(500, 1), caption: plainText(1000).default(''),
  photoDate: CalendarDateSchema.nullable().default(null), sortOrder: SortOrderSchema,
  featured: z.boolean().default(false),
  status: VisibilitySchema.default('draft'),
};
export const FitnessPhotoDraftSchema = z.object(photoDraftShape).strict();
export const FitnessPhotoSchema = z.object({
  ...photoDraftShape, entryId: IdSchema, status: VisibilitySchema,
  createdAt: UtcTimestampSchema, updatedAt: UtcTimestampSchema,
}).strict();
const fitnessEntryDraftShape = {
  entryDate: CalendarDateSchema, title: plainText(120).default(''), caption: plainText(2000).default(''),
  tags: z.array(plainText(40, 1)).max(20).default([]),
  sortOrder: SortOrderSchema, featured: z.boolean().default(false),
  photos: z.array(FitnessPhotoDraftSchema).max(100).default([]),
};
function uniquePhotos(value: { photos: { id: string }[] }, ctx: z.RefinementCtx) { requireUniqueIds(value.photos, ctx, ['photos']); }
function validateFitnessEntry(value: { photos: { id: string }[]; tags: string[] }, ctx: z.RefinementCtx) {
  uniquePhotos(value, ctx);
  if (new Set(value.tags).size !== value.tags.length) ctx.addIssue({ code: 'custom', path: ['tags'], message: '标签不可重复' });
}
export const FitnessEntryDraftSchema = z.object(fitnessEntryDraftShape).strict().superRefine(validateFitnessEntry);
export const FitnessEntrySchema = z.object({
  ...fitnessEntryDraftShape, id: IdSchema, status: VisibilitySchema, version: VersionSchema,
  createdAt: UtcTimestampSchema, updatedAt: UtcTimestampSchema,
}).strict().superRefine(validateFitnessEntry);
export const FitnessEntryInputSchema = z.object({ ...fitnessEntryDraftShape, expectedVersion: VersionSchema }).strict().superRefine(validateFitnessEntry);
export type FitnessPhotoDraft = z.infer<typeof FitnessPhotoDraftSchema>;
export type FitnessPhoto = z.infer<typeof FitnessPhotoSchema>;
export type FitnessEntryDraft = z.infer<typeof FitnessEntryDraftSchema>;
export type FitnessEntry = z.infer<typeof FitnessEntrySchema>;

export const AlbumPhotoSchema = z.object(photoDraftShape).strict();
export const AlbumDraftSchema = z.object({
  title: plainText(120), slug: z.union([z.literal(''), SlugSchema]), description: plainText(5000).default(''),
  coverAssetId: IdSchema.nullable().default(null), photos: z.array(AlbumPhotoSchema).max(500).default([]),
  featured: z.boolean().default(false), sortOrder: SortOrderSchema,
}).strict().superRefine(uniquePhotos);
export type AlbumDraft = z.infer<typeof AlbumDraftSchema>;
export type AlbumPhoto = z.infer<typeof AlbumPhotoSchema>;

export const PlaylistTrackSchema = z.object({
  id: IdSchema, title: plainText(120, 1), artist: plainText(120).default(''),
  assetId: IdSchema.optional(), providerRef: ProviderRefSchema.optional(),
  coverAssetId: IdSchema.nullable().default(null), sortOrder: SortOrderSchema,
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.assetId) === Boolean(value.providerRef)) ctx.addIssue({ code: 'custom', path: ['assetId'], message: '曲目必须且只能有一个媒体来源' });
  if (value.providerRef && !['tencent', 'netease'].includes(value.providerRef.provider)) {
    ctx.addIssue({ code: 'custom', path: ['providerRef', 'provider'], message: '歌单只接受预设音乐服务' });
  }
});
export const PlaylistDraftSchema = z.object({
  name: plainText(120, 1), source: z.enum(['local', 'tencent', 'netease']),
  sourceId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u).nullable().default(null),
  sortOrder: SortOrderSchema, enabled: z.boolean().default(true), isDefault: z.boolean().default(false),
  tracks: z.array(PlaylistTrackSchema).max(500).default([]),
}).strict().superRefine((value, ctx) => {
  requireUniqueIds(value.tracks, ctx, ['tracks']);
  if (value.source === 'local' && value.sourceId !== null) ctx.addIssue({ code: 'custom', path: ['sourceId'], message: '本地歌单不使用外部来源 ID' });
  if (value.source !== 'local' && value.sourceId === null) ctx.addIssue({ code: 'custom', path: ['sourceId'], message: '外部歌单需要来源 ID' });
});
export type PlaylistTrack = z.infer<typeof PlaylistTrackSchema>;
export type PlaylistDraft = z.infer<typeof PlaylistDraftSchema>;

const commentShape = {
  nickname: plainText(CONTENT_LIMITS.nicknameCharacters).default(''),
  body: plainText(CONTENT_LIMITS.commentCharacters, 1),
  challengeToken: z.string().max(4096).optional(),
  website: z.literal('').optional(),
  startedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
};
export const CommentInputSchema = z.discriminatedUnion('targetType', [
  z.object({ ...commentShape, targetType: z.literal('guestbook'), targetId: z.null().default(null) }).strict(),
  z.object({ ...commentShape, targetType: z.literal('creation'), targetId: IdSchema }).strict(),
  z.object({ ...commentShape, targetType: z.literal('album'), targetId: IdSchema }).strict(),
]);
export const ContactInputSchema = z.object({
  nickname: plainText(CONTENT_LIMITS.nicknameCharacters).default(''),
  email: z.string().trim().max(254).email(), message: plainText(5000, 1),
  challengeToken: z.string().max(4096).optional(),
  website: z.literal('').optional(),
  startedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export const CommentReceiptSchema = z.object({ receiptId: IdSchema, status: z.literal('pending') }).strict();
export const ContactReceiptSchema = z.object({ receiptId: IdSchema }).strict();
export type CommentInput = z.infer<typeof CommentInputSchema>;
export type ContactInput = z.infer<typeof ContactInputSchema>;
