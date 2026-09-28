import { z } from 'zod';
import { plainText, UtcTimestampSchema } from './common';

export const DOUYIN_SEC_UID = 'MS4wLjABAAAAKZ2zSL9DDu1Uc3IZleN2zqIqoOpNXtwvAW4_2E6PBrLmkyTMw_MsrzxGVrQvvI1-' as const;
export const DOUYIN_PROFILE_URL = `https://www.douyin.com/user/${DOUYIN_SEC_UID}` as const;
/** The one avatar CDN and path observed in the anonymous fixed-account response. */
export function isDouyinAvatarUrl(value: string): boolean {
  return value.length <= 512 && !/\s/u.test(value) && /^https:\/\/p3-pc\.douyinpic\.com\/aweme\/1080x1080\/aweme-avatar\/[A-Za-z0-9_-]+\.(?:jpeg|jpg|png|webp)$/u.test(value);
}
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
export const DouyinWorkSchema = z.object({
  id: z.string().length(19).regex(/^[1-9]\d{18}$/u), title: plainText(200, 1), kind: z.enum(['video', 'note']),
  url: z.string().regex(/^https:\/\/www\.douyin\.com\/(?:video|note)\/[1-9]\d{18}$/u),
  publishedAt: UtcTimestampSchema.nullable(),
}).strict().refine(work => work.url === `https://www.douyin.com/${work.kind}/${work.id}`, 'Work URL must match its kind and ID');
export type DouyinWork = z.infer<typeof DouyinWorkSchema>;
export const DouyinProfileSchema = z.object({
  secUid: z.literal(DOUYIN_SEC_UID), profileUrl: z.literal(DOUYIN_PROFILE_URL),
  name: plainText(80, 1).nullable(), signature: plainText(500).nullable(), avatarUrl: z.string().refine(isDouyinAvatarUrl).nullable(),
  followers: count, following: count, postCount: count, likes: count,
  updatedAt: UtcTimestampSchema.nullable(), status: z.enum(['fresh', 'stale', 'snapshot', 'unavailable']), authorization: z.literal('public'),
  works: z.array(DouyinWorkSchema).max(6).optional(), worksUpdatedAt: UtcTimestampSchema.nullable().optional(),
}).strict().superRefine((profile, context) => {
  if (profile.status === 'unavailable') {
    if ([profile.name, profile.signature, profile.avatarUrl, profile.followers, profile.following, profile.postCount, profile.likes, profile.updatedAt].some(value => value !== null) || profile.works?.length || profile.worksUpdatedAt) context.addIssue({ code: 'custom', message: 'Unavailable profiles must not claim account data' });
  } else if (!profile.updatedAt) context.addIssue({ code: 'custom', message: 'Available profiles require a capture timestamp' });
  if (profile.works && new Set(profile.works.map(work => work.id)).size !== profile.works.length) context.addIssue({ code: 'custom', message: 'Works must have unique IDs' });
  if (profile.status !== 'unavailable' && ((profile.works !== undefined && !profile.worksUpdatedAt) || (profile.worksUpdatedAt && profile.works === undefined))) context.addIssue({ code: 'custom', message: 'A captured works section requires both its list and capture timestamp' });
});
export type DouyinProfile = z.infer<typeof DouyinProfileSchema>;
