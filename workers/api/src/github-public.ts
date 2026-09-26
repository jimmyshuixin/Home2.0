import { GITHUB_ID, GITHUB_LOGIN, GITHUB_PROFILE_URL, GitHubProfileSchema, GitHubRepositorySchema, isGitHubAvatarUrl, type GitHubProfile, type GitHubRepository } from '@xvyin/contracts';

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function text(value: unknown, max: number): string | null {
  return typeof value === 'string' ? Array.from(value.replace(/<[^>]*>/gu, '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim()).slice(0, max).join('') || null : null;
}
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
function pastTimestamp(value: unknown, now: number): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || Date.parse(value) > now) return null;
  return new Date(value).toISOString();
}
/** Anonymous GitHub REST results only. No authentication or upstream response fields are stored wholesale. */
export function sanitizeGitHubProfile(value: unknown, now: number): GitHubProfile {
  const source = record(value);
  if (source?.id !== GITHUB_ID || source.login !== GITHUB_LOGIN || source.html_url !== GITHUB_PROFILE_URL || source.type !== 'User') throw new Error('GITHUB_INVALID_PUBLIC_PROFILE');
  return GitHubProfileSchema.parse({
    id: GITHUB_ID, login: GITHUB_LOGIN, profileUrl: GITHUB_PROFILE_URL,
    name: text(source.name, 80), bio: text(source.bio, 500), avatarUrl: typeof source.avatar_url === 'string' && isGitHubAvatarUrl(source.avatar_url) ? source.avatar_url : null,
    publicRepos: count(source.public_repos), followers: count(source.followers), following: count(source.following),
    updatedAt: new Date(now).toISOString(), status: 'fresh', authorization: 'public',
  });
}
/** Select from the public user's repository endpoint; never accept fork, private or other-owner records. */
export function sanitizeGitHubRepositories(value: unknown, now: number): GitHubRepository[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('GITHUB_INVALID_PUBLIC_REPOSITORIES');
  const repositories: GitHubRepository[] = [];
  for (const raw of value) {
    const repo = record(raw), owner = record(repo?.owner);
    if (!repo || repo.private !== false || repo.fork !== false || (repo.visibility !== undefined && repo.visibility !== 'public') || owner?.id !== GITHUB_ID || owner.login !== GITHUB_LOGIN) continue;
    const parsed = GitHubRepositorySchema.safeParse({ name: repo.name, description: text(repo.description, 500), url: repo.html_url, language: text(repo.language, 80), stars: count(repo.stargazers_count), forks: count(repo.forks_count), pushedAt: pastTimestamp(repo.pushed_at, now) });
    if (!parsed.success) throw new Error('GITHUB_INVALID_PUBLIC_REPOSITORIES');
    if (!repositories.some(existing => existing.name.toLowerCase() === parsed.data.name.toLowerCase())) repositories.push(parsed.data);
  }
  return repositories.sort((a, b) => (b.pushedAt || '').localeCompare(a.pushedAt || '') || b.stars - a.stars || a.name.localeCompare(b.name)).slice(0, 6);
}
export function unavailableGitHubProfile(): GitHubProfile {
  return { id: GITHUB_ID, login: GITHUB_LOGIN, profileUrl: GITHUB_PROFILE_URL, name: null, bio: null, avatarUrl: null, publicRepos: null, followers: null, following: null, updatedAt: null, status: 'unavailable', authorization: 'public' };
}
