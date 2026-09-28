import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DouyinProfileSchema, DOUYIN_SEC_UID, DOUYIN_PROFILE_URL, SocialSyncInputSchema } from '@xvyin/contracts';
import { douyinCapture, readDouyinCapture, syncPublicData } from '../public-social-sync';

const now = Date.parse('2026-09-28T01:15:00Z');
const capturedAt = new Date(now).toISOString();
const profile = () => ({ secUid: DOUYIN_SEC_UID, profileUrl: DOUYIN_PROFILE_URL, name: '虚宁', signature: '公开简介', avatarUrl: null, followers: 85, following: 3, postCount: 22, likes: 6559, updatedAt: capturedAt, status: 'fresh', authorization: 'public', works: [{ id: '7661639577056136457', kind: 'video', title: '星空摄影', url: 'https://www.douyin.com/video/7661639577056136457', publishedAt: '2026-07-12T13:54:43.000Z' }], worksUpdatedAt: capturedAt });
const environment = { GITHUB_REPOSITORY: 'jimmyshuixin/Home2.0', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://run-actions-1.actions.githubusercontent.com/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-only-secret' };
const claimId = 'a4538797-be8c-4814-8f14-e05e0ea69e35';

describe('isolated Douyin artifact import', () => {
  it('projects only public fields and produces the strict contract including note URLs', () => {
    const source = profile();
    source.works[0] = { ...source.works[0]!, kind: 'note', url: 'https://www.douyin.com/note/7661639577056136457' };
    const result = douyinCapture({ status: 'ok', profile: { ...source, cookie: 'never-import', raw: { private: true } } }, now);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw Error('Expected a profile');
    expect(DouyinProfileSchema.parse(result.profile)).toEqual(result.profile);
    expect(JSON.stringify(result)).not.toContain('never-import');
    expect(result.profile.works?.[0]?.kind).toBe('note');
  });
  it('rejects account swaps, URL confusion, duplicate IDs, future dates and oversize lists', () => {
    for (const change of [
      { secUid: 'foreign' }, { profileUrl: 'https://evil.test/' }, { updatedAt: '2099-01-01T00:00:00Z' },
      { works: [{ ...profile().works[0], url: 'https://evil.test/' }] },
      { works: [{ ...profile().works[0], kind: 'note' }] },
      { works: [profile().works[0], profile().works[0]] },
      { works: Array(7).fill(profile().works[0]) }, { worksUpdatedAt: null },
      { works: [{ ...profile().works[0], publishedAt: '2099-01-01T00:00:00Z' }] },
    ]) expect(douyinCapture({ status: 'ok', profile: { ...profile(), ...change } }, now)).toEqual({ status: 'failed', reason: 'invalid-response' });
  });
  it('keeps zero distinct from unknown, bounds Unicode text and drops unsafe avatars', () => {
    const result = douyinCapture({ status: 'ok', profile: { ...profile(), followers: 0, following: -1, likes: '10', name: '🐷'.repeat(80), signature: '🐷'.repeat(500), avatarUrl: 'https://p3-pc.douyinpic.com/aweme/1080x1080/aweme-avatar/a.jpeg?session=secret' } }, now);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw Error('Expected profile');
    expect(result.profile).toMatchObject({ followers: 0, following: null, likes: null, avatarUrl: null });
    expect(DouyinProfileSchema.parse(result.profile)).toBeDefined();
  });
  it('distinguishes failed works from an intentionally empty captured page', () => {
    const { works: _works, worksUpdatedAt: _time, ...partial } = profile();
    const result = douyinCapture({ status: 'ok', profile: partial }, now);
    expect(result.status === 'ok' && result.profile.works).toBeUndefined();
    const empty = douyinCapture({ status: 'ok', profile: { ...profile(), works: [] } }, now);
    expect(empty.status === 'ok' && empty.profile.works).toEqual([]);
  });
  it('bounds local artifact reads and fails closed if absent, malformed or too large', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'douyin-import-'));
    try {
      const file = join(dir, 'capture.json');
      expect(await readDouyinCapture(file)).toEqual({ status: 'failed', reason: 'unavailable' });
      await writeFile(file, 'x'.repeat(32 * 1024 + 1));
      expect(await readDouyinCapture(file)).toEqual({ status: 'failed', reason: 'invalid-response' });
      await writeFile(file, JSON.stringify({ status: 'ok', profile: profile() }));
      expect((await readDouyinCapture(file)).status).toBe('ok');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('claim-only step neither fetches providers nor imports; downstream import uses the existing claim', async () => {
    const logger = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalExitCode = process.exitCode;
    try {
      const seen: string[] = [];
      const claim = await syncPublicData(environment, async url => {
        seen.push(String(url));
        return Response.json(String(url).includes('actions.githubusercontent.com') ? { value: 'header.payload.signature' } : { data: { accepted: true, claimId } });
      }, { phase: 'claim' });
      expect(claim).toBe(claimId); expect(seen).toHaveLength(2);
      expect(seen[1]).toContain('/social-sync/claim');
      const imported: unknown[] = [];
      await syncPublicData(environment, async (url, init) => {
        const target = String(url);
        if (target.includes('actions.githubusercontent.com')) return Response.json({ value: 'header.payload.signature' });
        if (target.endsWith('/social-sync')) {
          imported.push(JSON.parse(String(init?.body)));
          return Response.json({ data: { imported: true } });
        }
        expect(target).not.toContain('/social-sync/claim');
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        return new Response(null, { status: 503 });
      }, { phase: 'import', claimId, douyin: { status: 'ok', profile: profile() } });
      expect(imported).toHaveLength(1);
      expect(SocialSyncInputSchema.parse(imported[0])).toMatchObject({ claimId, douyin: { status: 'ok' }, bilibili: { status: 'failed' }, github: { status: 'failed' } });
    } finally { logger.mockRestore(); process.exitCode = originalExitCode; }
  });
});
