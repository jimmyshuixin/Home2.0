import { z } from 'zod';
import { IdSchema, SafeHrefSchema, Sha256Schema, plainText } from './common';
import { MEDIA_LIMITS } from './limits';

export const MediaKindSchema = z.enum(['image', 'audio', 'video', 'file']);
export type MediaKind = z.infer<typeof MediaKindSchema>;
export const ImageMimeSchema = z.enum(['image/jpeg', 'image/png', 'image/webp']);
export const AudioMimeSchema = z.enum(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/x-wav']);
export const VideoMimeSchema = z.enum(['video/mp4', 'video/webm']);
export const FileMimeSchema = z.enum(['application/pdf', 'text/plain', 'text/vtt']);
export const AllowedMimeSchema = z.union([ImageMimeSchema, AudioMimeSchema, VideoMimeSchema, FileMimeSchema]);
export const OriginalFilenameSchema = z.string().min(1).max(255)
  .refine(value => value !== '.' && value !== '..' && !/[\/\\\u0000-\u001F\u007F]/u.test(value), '文件名不能包含路径或控制字符');
const uploadShape = { originalName: OriginalFilenameSchema, expectedSha256: Sha256Schema.optional() };
function byteCount(limit: number) { return z.number().int().positive().max(limit); }

/** A declaration, never proof of file type. Complete-upload must inspect actual stored bytes. */
export const UploadMetadataSchema = z.discriminatedUnion('kind', [
  z.object({ ...uploadShape, kind: z.literal('image'), expectedMime: ImageMimeSchema, expectedBytes: byteCount(MEDIA_LIMITS.imageBytes) }).strict(),
  z.object({ ...uploadShape, kind: z.literal('audio'), expectedMime: AudioMimeSchema, expectedBytes: byteCount(MEDIA_LIMITS.audioBytes) }).strict(),
  z.object({ ...uploadShape, kind: z.literal('video'), expectedMime: VideoMimeSchema, expectedBytes: byteCount(MEDIA_LIMITS.videoBytes) }).strict(),
  z.object({ ...uploadShape, kind: z.literal('file'), expectedMime: FileMimeSchema, expectedBytes: byteCount(MEDIA_LIMITS.fileBytes) }).strict(),
]);
export type UploadMetadata = z.infer<typeof UploadMetadataSchema>;
export const UploadStateSchema = z.enum(['created', 'uploading', 'uploaded', 'validating', 'processing', 'ready', 'failed', 'expired']);
export const MediaProcessingStatusSchema = UploadStateSchema;

const photoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, '拍摄日期无效');
/** A deliberately small public EXIF allowlist. Never copy GPS, serials, owners or MakerNotes. */
export const PhotographyMetadataSchema = z.object({
  cameraMake: plainText(100, 1).optional(), cameraModel: plainText(150, 1).optional(),
  lensMake: plainText(100, 1).optional(), lensModel: plainText(150, 1).optional(),
  focalLengthMm: z.number().positive().max(10000).optional(),
  focalLength35mm: z.number().positive().max(10000).optional(),
  exposureSeconds: z.number().positive().max(86400).optional(),
  aperture: z.number().positive().max(1024).optional(),
  iso: z.number().int().positive().max(100_000_000).optional(),
  // EXIF's local camera clock is preserved; an absent offset is not guessed.
  takenAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u)
    .refine(value => photoDate.safeParse(value.slice(0, 10)).success, '拍摄时间无效').optional(),
  takenDate: photoDate.optional(),
  timezoneOffset: z.string().regex(/^[+-](?:0\d|1[0-3]):[0-5]\d$|^[+-]14:00$/u).optional(),
}).strict();
export type PhotographyMetadata = z.infer<typeof PhotographyMetadataSchema>;
const pixelDimension = z.number().int().positive().max(MEDIA_LIMITS.imagePixels);
export const DetectedMediaMetadataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), detectedMime: ImageMimeSchema, bytes: byteCount(MEDIA_LIMITS.imageBytes), sha256: Sha256Schema, width: pixelDimension, height: pixelDimension, photography: PhotographyMetadataSchema.optional() }).strict(),
  z.object({ kind: z.literal('audio'), detectedMime: AudioMimeSchema, bytes: byteCount(MEDIA_LIMITS.audioBytes), sha256: Sha256Schema, durationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ kind: z.literal('video'), detectedMime: VideoMimeSchema, bytes: byteCount(MEDIA_LIMITS.videoBytes), sha256: Sha256Schema, width: pixelDimension, height: pixelDimension, durationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ kind: z.literal('file'), detectedMime: FileMimeSchema, bytes: byteCount(MEDIA_LIMITS.fileBytes), sha256: Sha256Schema }).strict(),
]).superRefine((value, ctx) => {
  if (value.kind === 'image' && value.width * value.height > MEDIA_LIMITS.imagePixels) {
    ctx.addIssue({ code: 'custom', path: ['width'], message: '图片不得超过 1.5 亿像素' });
  }
});
export type DetectedMediaMetadata = z.infer<typeof DetectedMediaMetadataSchema>;

export const MediaVariantRoleSchema = z.enum(['thumb', 'content', 'large', 'poster', 'captions', 'playback', 'download']);
export const PublicMediaVariantSchema = z.object({
  role: MediaVariantRoleSchema, url: SafeHrefSchema.refine(value => !value.startsWith('#'), '媒体需要完整资源路径'),
  mime: AllowedMimeSchema, bytes: byteCount(MEDIA_LIMITS.videoBytes),
  width: pixelDimension.optional(), height: pixelDimension.optional(),
  durationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export const PublicMediaAssetSchema = z.object({
  id: IdSchema, kind: MediaKindSchema, variants: z.array(PublicMediaVariantSchema).min(1).max(20),
  width: pixelDimension.optional(), height: pixelDimension.optional(),
  durationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  photography: PhotographyMetadataSchema.optional(),
}).strict();
export type PublicMediaVariant = z.infer<typeof PublicMediaVariantSchema>;
export type PublicMediaAsset = z.infer<typeof PublicMediaAssetSchema>;

/** Call inside the store's atomic reservation transaction; this helper alone is not locking. */
export function canReserveMediaBytes(usedBytes: number, reservedBytes: number, requestedBytes: number): boolean {
  if (![usedBytes, reservedBytes, requestedBytes].every(value => Number.isSafeInteger(value) && value >= 0) || requestedBytes === 0) return false;
  return usedBytes <= MEDIA_LIMITS.totalBytes && reservedBytes <= MEDIA_LIMITS.totalBytes - usedBytes
    && requestedBytes <= MEDIA_LIMITS.totalBytes - usedBytes - reservedBytes;
}
