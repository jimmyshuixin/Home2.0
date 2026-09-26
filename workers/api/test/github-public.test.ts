import { describe, expect, it } from 'vitest';
import { GitHubProfileSchema, GitHubRepositorySchema } from '@xvyin/contracts';
import { sanitizeGitHubProfile, sanitizeGitHubRepositories, unavailableGitHubProfile } from '../src/github-public';

const now = Date.UTC(2026, 8, 26, 15);
const user = () => ({ id: 121843277, login: 'jimmyshuixin', type: 'User', html_url: 'https://github.com/jimmyshuixin', name: '<b>Name</b>', bio: 'Hello\u202Eworld', avatar_url: 'https://avatars.githubusercontent.com/u/121843277?v=4', public_repos: 5, followers: 2, following: 1, email: 'excluded', private_repos: 42 });
const repo = (name = 'Home2.0') => ({ name, html_url: `https://github.com/jimmyshuixin/${name}`, private: false, visibility: 'public', fork: false, owner: { id: 121843277, login: 'jimmyshuixin' }, description: '<b>Public</b>', language: 'TypeScript', stargazers_count: 2, forks_count: 1, pushed_at: new Date(now - 1000).toISOString(), permissions: { admin: true } });
describe('fixed public GitHub projection', () => {
  it('requires immutable account identity and excludes nonpublic fields and formatting controls', () => {
    const profile = sanitizeGitHubProfile(user(), now);
    expect(profile).toMatchObject({ name: 'Name', bio: 'Hello world', publicRepos: 5, followers: 2 });
    expect(JSON.stringify(profile)).not.toMatch(/email|excluded|private_repos/u);
    for (const change of [{ id: 123 }, { login: 'other' }, { html_url: 'https://github.com/other' }, { type: 'Organization' }]) expect(() => sanitizeGitHubProfile({ ...user(), ...change }, now)).toThrow();
  });
  it('does not fabricate missing or malformed counters and rejects avatar redirects/other identities', () => {
    expect(sanitizeGitHubProfile({ ...user(), followers: undefined, following: -1, public_repos: '99', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }, now)).toMatchObject({ followers: null, following: null, publicRepos: null, avatarUrl: null });
    expect(GitHubProfileSchema.parse(unavailableGitHubProfile()).status).toBe('unavailable');
  });
  it('only exposes owned public nonfork repositories, preserving a real zero count', () => {
    const list = sanitizeGitHubRepositories([repo(), { ...repo('private'), private: true }, { ...repo('fork'), fork: true }, { ...repo('other'), owner: { id: 12, login: 'other' } }, { ...repo('zero'), stargazers_count: 0, forks_count: 0 }], now);
    expect(list.map(value => value.name)).toEqual(['Home2.0', 'zero']); expect(list[1]).toMatchObject({ stars: 0, forks: 0 });
    expect(JSON.stringify(list)).not.toContain('permissions');
  });
  it('rejects malformed public lists and cannot substitute an unrelated repository URL', () => {
    expect(() => sanitizeGitHubRepositories({ message: 'rate limited' }, now)).toThrow();
    expect(() => sanitizeGitHubRepositories([{ ...repo(), html_url: 'https://github.com/other/Home2.0' }], now)).toThrow();
    expect(GitHubRepositorySchema.safeParse({ name: '..', description: null, url: 'https://github.com/jimmyshuixin/..', stars: 0, forks: 0, language: null, pushedAt: null }).success).toBe(false);
    expect(sanitizeGitHubRepositories(Array.from({ length: 8 }, (_, i) => repo(`repo${i}`)), now)).toHaveLength(6);
  });
});
