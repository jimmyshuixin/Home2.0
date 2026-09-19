import { z } from 'zod';
import { IdSchema } from './common';
import { CalendarDateSchema } from './dates';

export const EngagementTargetSchema = z.object({
  type: z.enum(['creation', 'album', 'photo', 'fitness']), id: IdSchema, parentId: IdSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.type === 'photo') !== Boolean(value.parentId)) ctx.addIssue({ code: 'custom', path: ['parentId'], message: '照片需要相册 ID，其他内容不使用相册 ID' });
});
export type EngagementTarget = z.infer<typeof EngagementTargetSchema>;
export const VisitInputSchema = z.object({
  visitorId: z.string().uuid(), visitId: z.string().uuid(), type: z.enum(['start', 'heartbeat', 'end']),
  startedAt: z.number().int().nonnegative(), activeMs: z.number().int().min(0).max(86_400_000),
  path: z.string().max(256).regex(/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*\/?$/u),
  target: EngagementTargetSchema.optional(),
}).strict();
export type VisitInput = z.infer<typeof VisitInputSchema>;
export const LikeInputSchema = z.object({ ...EngagementTargetSchema.shape, visitorId: z.string().uuid(), liked: z.boolean() }).strict();
export const AnalyticsQuerySchema = z.object({ date: CalendarDateSchema, cursor: z.string().max(160).optional() }).strict();
export interface LikeState { count: number; liked: boolean }
export interface VisitRecord {
  id: string; path: string; title: string; target: EngagementTarget | null;
  startedAt: string; updatedAt: string; activeMs: number; ended: boolean;
  ip: string | null; country: string | null; region: string | null; city: string | null;
}
export interface TrafficSummary {
  date: string; pageViews: number; visitors: number; activeMs: number; likesAdded: number;
  paths: Array<{ path: string; title: string; views: number; activeMs: number }>;
}
export interface AnalyticsReport {
  summary: TrafficSummary; visits: VisitRecord[]; history: TrafficSummary[];
  limits: { retentionDays: number; dailyWriteLimit: number; writesUsed: number; maxVisitsPerDay: number; detailAvailable: boolean; limited: boolean };
}
