import { z } from 'zod';
import { plainText, UtcTimestampSchema } from './common';

export const GITHUB_ID = 121843277 as const;
export const GITHUB_LOGIN = 'jimmyshuixin' as const;
export const GITHUB_PROFILE_URL = 'https://github.com/jimmyshuixin' as const;
export function isGitHubAvatarUrl(value: string): boolean {
  return /^https:\/\/avatars\.githubusercontent\.com\/u\/121843277(?:\?v=4)?$/u.test(value);
}
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const GitHubRepositorySchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u).refine(value => value !== '.' && value !== '..'),
  description: plainText(500).nullable(),
  url: z.string().regex(/^https:\/\/github\.com\/jimmyshuixin\/[A-Za-z0-9_.-]{1,100}$/u),
  language: plainText(80, 1).nullable(), stars: count, forks: count, pushedAt: UtcTimestampSchema.nullable(),
}).strict().refine(value => value.url === `${GITHUB_PROFILE_URL}/${value.name}`, 'Repository URL must match its name');
export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;
export const GitHubProfileSchema = z.object({
  id: z.literal(GITHUB_ID), login: z.literal(GITHUB_LOGIN), profileUrl: z.literal(GITHUB_PROFILE_URL),
  name: plainText(80, 1).nullable(), bio: plainText(500).nullable(), avatarUrl: z.string().refine(isGitHubAvatarUrl).nullable(),
  publicRepos: count.nullable(), followers: count.nullable(), following: count.nullable(),
  updatedAt: UtcTimestampSchema.nullable(), status: z.enum(['fresh', 'stale', 'snapshot', 'unavailable']), authorization: z.literal('public'),
  repositories: z.array(GitHubRepositorySchema).max(6).optional(), repositoriesUpdatedAt: UtcTimestampSchema.nullable().optional(),
}).strict().superRefine((profile, context) => {
  if (profile.status === 'unavailable') {
    if ([profile.name, profile.bio, profile.avatarUrl, profile.publicRepos, profile.followers, profile.following, profile.updatedAt].some(value => value !== null) || profile.repositories?.length || profile.repositoriesUpdatedAt) context.addIssue({ code: 'custom', message: 'Unavailable profiles must not claim account data' });
  } else if (!profile.updatedAt) context.addIssue({ code: 'custom', message: 'Available profiles require a capture timestamp' });
  if (profile.repositories && new Set(profile.repositories.map(repo => repo.name.toLowerCase())).size !== profile.repositories.length) context.addIssue({ code: 'custom', message: 'Repositories must be unique' });
});
export type GitHubProfile = z.infer<typeof GitHubProfileSchema>;
