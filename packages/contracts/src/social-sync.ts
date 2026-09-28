import { z } from 'zod';
import { BilibiliProfileSchema } from './bilibili';
import { GitHubProfileSchema } from './github';
import { DouyinProfileSchema } from './douyin';

export const SocialSyncFailureReasonSchema = z.enum(['timeout', 'network', 'upstream-blocked', 'invalid-response', 'rate-limited', 'unavailable']);
const failed = z.object({ status: z.literal('failed'), reason: SocialSyncFailureReasonSchema }).strict();
export const SocialSyncInputSchema = z.object({
  claimId: z.uuid(),
  bilibili: z.discriminatedUnion('status', [failed, z.object({ status: z.literal('ok'), profile: BilibiliProfileSchema.refine(value => value.status === 'fresh' && value.updatedAt !== null, 'Only newly captured public data may be imported') }).strict()]),
  github: z.discriminatedUnion('status', [failed, z.object({ status: z.literal('ok'), profile: GitHubProfileSchema.refine(value => value.status === 'fresh' && value.updatedAt !== null, 'Only newly captured public data may be imported') }).strict()]),
  // Older trusted runners omit Douyin; omission leaves its existing data and attempt metadata untouched.
  douyin: z.discriminatedUnion('status', [failed, z.object({ status: z.literal('ok'), profile: DouyinProfileSchema.refine(value => value.status === 'fresh' && value.updatedAt !== null, 'Only newly captured public data may be imported') }).strict()]).optional(),
}).strict();
export type SocialSyncInput = z.infer<typeof SocialSyncInputSchema>;
export interface SocialSyncClaim { accepted: boolean; claimId?: string; expiresAt?: string; nextAllowedAt: string }
export interface SocialSyncResult { imported: true; bilibili: 'updated' | 'retained'; github: 'updated' | 'retained'; douyin?: 'updated' | 'retained' }
