import { z } from 'zod';
import { IdSchema, plainText, UtcTimestampSchema } from './common';
import { SCHEMA_VERSION } from './limits';

export const API_ERROR_STATUS = {
  INVALID_JSON: 400, INVALID_INPUT: 422, VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401, AUTH_NOT_CONFIGURED: 503, FORBIDDEN: 403, CSRF_INVALID: 403,
  NOT_FOUND: 404, VERSION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413, FUTURE_START_DATE: 422, INVALID_DATE: 422, INVALID_TIME_SOURCE: 503,
  UPLOAD_TYPE_NOT_ALLOWED: 422, UPLOAD_MISMATCH: 422, UPLOAD_EXPIRED: 409,
  MEDIA_NOT_READY: 409, MEDIA_IN_USE: 409, MEDIA_QUOTA_EXCEEDED: 413,
  RATE_LIMITED: 429, PUBLISH_FAILED: 503, SERVICE_UNAVAILABLE: 503, INTERNAL_ERROR: 500,
} as const;
export type ApiErrorCode = keyof typeof API_ERROR_STATUS;
export const ApiErrorCodeSchema = z.enum(Object.keys(API_ERROR_STATUS) as [ApiErrorCode, ...ApiErrorCode[]]);
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
export const ApiMetaSchema = z.object({
  requestId: IdSchema, schemaVersion: z.literal(SCHEMA_VERSION).optional(),
  nextCursor: z.string().max(2048).nullable().optional(), releaseId: IdSchema.optional(), updatedAt: UtcTimestampSchema.optional(),
}).strict();
export const ApiSuccessMetaSchema = ApiMetaSchema.extend({ schemaVersion: z.literal(SCHEMA_VERSION) });
export const ApiErrorDetailSchema = z.object({
  code: ApiErrorCodeSchema, message: plainText(500, 1),
  fields: z.record(z.string().max(200), z.array(plainText(300, 1)).max(10)).optional(),
}).strict();
export const ApiErrorEnvelopeSchema = z.object({ error: ApiErrorDetailSchema, meta: ApiMetaSchema }).strict();
export function createApiSuccessSchema<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: ApiSuccessMetaSchema }).strict();
}
export type ApiMeta = z.infer<typeof ApiMetaSchema>;
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;
export interface ApiSuccess<T> { data: T; meta: z.infer<typeof ApiSuccessMetaSchema> }
export type ApiResponse<T> = ApiSuccess<T> | ApiErrorEnvelope;

/** Validation only; never use the submitted name as authorization without password verification. */
export const AdminLoginInputSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(128),
}).strict();
export type AdminLoginInput = z.infer<typeof AdminLoginInputSchema>;
