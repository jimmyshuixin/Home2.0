import { z } from 'zod';
import { plainText, UtcTimestampSchema } from './common';

export const BILIBILI_UID = '520237303' as const;
export const BILIBILI_PROFILE_URL = 'https://space.bilibili.com/520237303' as const;

/** Only Bilibili's image hosts may provide the public account avatar. */
export function isBilibiliAvatarUrl(value: string): boolean {
  if (value.length > 512 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^i[012]\.hdslb\.com$/u.test(url.hostname)
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && /^\/bfs\/face\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:jpe?g|png|webp)$/iu.test(url.pathname);
  } catch { return false; }
}

const publicCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
export function isBilibiliCoverUrl(value: string): boolean {
  if (value.length > 512 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^i[012]\.hdslb\.com$/u.test(url.hostname)
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && /^\/bfs\/(?:archive|storyff)\/[a-zA-Z0-9_/-]+\.(?:jpe?g|png|webp)$/iu.test(url.pathname);
  } catch { return false; }
}
export const BilibiliWorkSchema = z.object({
  bvid: z.string().regex(/^BV[1-9A-HJ-NP-Za-km-z]{10}$/u), title: plainText(200, 1),
  url: z.string().regex(/^https:\/\/www\.bilibili\.com\/video\/BV[1-9A-HJ-NP-Za-km-z]{10}\/$/u),
  coverUrl: z.string().refine(isBilibiliCoverUrl).nullable(), publishedAt: UtcTimestampSchema.nullable(),
  views: publicCount, durationSeconds: publicCount,
}).strict();
export type BilibiliWork = z.infer<typeof BilibiliWorkSchema>;
export const BilibiliProfileSchema = z.object({
  uid: z.literal(BILIBILI_UID),
  profileUrl: z.literal(BILIBILI_PROFILE_URL),
  name: plainText(80, 1).nullable(),
  signature: plainText(500).nullable(),
  avatarUrl: z.string().refine(isBilibiliAvatarUrl).nullable(),
  followers: publicCount,
  videoCount: publicCount,
  likes: publicCount,
  updatedAt: UtcTimestampSchema.nullable(),
  status: z.enum(['fresh', 'stale', 'snapshot', 'unavailable']),
  // A fixed public UID association is not proof of an OAuth authorization.
  authorization: z.literal('public'),
  works: z.array(BilibiliWorkSchema).max(12).optional(),
  worksUpdatedAt: UtcTimestampSchema.nullable().optional(),
}).strict().superRefine((profile, context) => {
  if (profile.status === 'unavailable') {
    if ([profile.name, profile.signature, profile.avatarUrl, profile.followers, profile.videoCount, profile.likes, profile.updatedAt].some(value => value !== null)) {
      context.addIssue({ code: 'custom', message: 'Unavailable profiles must not claim live account data' });
    }
  } else if (!profile.name || !profile.updatedAt) {
    context.addIssue({ code: 'custom', message: 'Available profiles require a name and update timestamp' });
  }
});
export type BilibiliProfile = z.infer<typeof BilibiliProfileSchema>;
