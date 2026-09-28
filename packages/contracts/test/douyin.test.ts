import { describe, expect, it } from 'vitest';
import { DOUYIN_PROFILE_URL, DOUYIN_SEC_UID, DouyinProfileSchema, DouyinWorkSchema, isDouyinAvatarUrl, SocialSyncInputSchema, type DouyinProfile } from '../src';

const date = '2026-09-28T04:00:00.000Z';
const avatar = 'https://p3-pc.douyinpic.com/aweme/1080x1080/aweme-avatar/tos-cn-i-c9aec8xkvj_43c319e87c5a452c80ad401c6979e6b7.jpeg';
const work = { id: '7661639577056136457', title: '公开作品', kind: 'video' as const, url: 'https://www.douyin.com/video/7661639577056136457', publishedAt: null };
const profile = (): DouyinProfile => ({ secUid: DOUYIN_SEC_UID, profileUrl: DOUYIN_PROFILE_URL, name: '公开作者', signature: '生活记录', avatarUrl: avatar, followers: null, following: 0, postCount: 42, likes: 1000, updatedAt: date, status: 'fresh', authorization: 'public', works: [work], worksUpdatedAt: date });

describe('fixed public Douyin contracts', () => {
  it('preserves large decimal work IDs, unknown counts and canonical video/note URLs', () => {
    expect(DouyinProfileSchema.parse(profile())).toEqual(profile());
    expect(DouyinWorkSchema.parse({ ...work, kind: 'note', url: `https://www.douyin.com/note/${work.id}` }).id).toBe(work.id);
    expect(DouyinProfileSchema.parse(profile()).followers).toBeNull();
  });
  it.each([
    { secUid: 'another-account' }, { profileUrl: 'https://www.douyin.com/user/another-account' }, { cookie: 'private' }, { raw: {} },
    { authorization: 'authenticated' }, { followers: -1 }, { followers: 1.5 }, { likes: Number.MAX_SAFE_INTEGER + 1 }, { postCount: '42' },
    { name: '字'.repeat(81) }, { signature: '字'.repeat(501) }, { signature: '<script>bad</script>' }, { updatedAt: null }, { updatedAt: '2026-09-28T12:00:00+08:00' },
  ])('rejects unsafe account projection %#', patch => { expect(DouyinProfileSchema.safeParse({ ...profile(), ...patch }).success).toBe(false); });
  it.each([
    'http://p3-pc.douyinpic.com/aweme/1080x1080/aweme-avatar/a.jpeg',
    avatar.replace('p3-pc.', 'p4-pc.'), avatar.replace('.com/', '.com.evil.invalid/'), avatar.replace('1080x1080', '100x100'),
    avatar.replace('https://', 'https://user:secret@'), avatar.replace('.com/', '.com:443/'), `${avatar}?token=private`, `${avatar}#private`, `${avatar}\n`,
    avatar.replace('aweme-avatar/', 'aweme-avatar/../'), avatar.replace('aweme-avatar/', 'aweme-avatar/%2f'), avatar.replace('.jpeg', '.svg'),
  ])('rejects avatars outside the observed clean CDN path %#', value => {
    expect(isDouyinAvatarUrl(value)).toBe(false); expect(DouyinProfileSchema.safeParse({ ...profile(), avatarUrl: value }).success).toBe(false);
  });
  it.each([
    { id: 7661639577056136457 }, { id: `0${work.id.slice(1)}` }, { id: `${work.id}\n`, url: `${work.url}\n` }, { id: `${work.id}0` },
    { kind: 'note' }, { url: 'https://www.douyin.com/video/7661639577056136458' }, { url: `${work.url}?from=share` }, { url: `${work.url}/` },
    { url: work.url.replace('www.', '') }, { private: true }, { title: '' }, { title: '字'.repeat(201) },
  ])('rejects ambiguous or malformed work %#', patch => { expect(DouyinWorkSchema.safeParse({ ...work, ...patch }).success).toBe(false); });
  it('requires section timestamps, unique bounded works, and honest unavailable data', () => {
    expect(DouyinProfileSchema.safeParse({ ...profile(), works: [work, work] }).success).toBe(false);
    const works = Array.from({ length: 7 }, (_, index) => ({ ...work, id: `766163957705613645${index}`, url: `https://www.douyin.com/video/766163957705613645${index}` }));
    expect(DouyinProfileSchema.safeParse({ ...profile(), works }).success).toBe(false);
    expect(DouyinProfileSchema.safeParse({ ...profile(), worksUpdatedAt: null }).success).toBe(false);
    expect(DouyinProfileSchema.safeParse({ ...profile(), works: undefined }).success).toBe(false);
    expect(DouyinProfileSchema.safeParse({ ...profile(), works: undefined, worksUpdatedAt: undefined }).success).toBe(true);
    expect(DouyinProfileSchema.safeParse({ ...profile(), status: 'unavailable' }).success).toBe(false);
    expect(DouyinProfileSchema.safeParse({ secUid: DOUYIN_SEC_UID, profileUrl: DOUYIN_PROFILE_URL, name: null, signature: null, avatarUrl: null, followers: null, following: null, postCount: null, likes: null, updatedAt: null, status: 'unavailable', authorization: 'public' }).success).toBe(true);
  });
  it('keeps old sync input compatible and only accepts new fresh Douyin captures', () => {
    const old = { claimId: '11111111-1111-4111-8111-111111111111', bilibili: { status: 'failed', reason: 'network' }, github: { status: 'failed', reason: 'network' } };
    expect(SocialSyncInputSchema.parse(old)).toEqual(old);
    expect(SocialSyncInputSchema.safeParse({ ...old, douyin: { status: 'ok', profile: profile() } }).success).toBe(true);
    expect(SocialSyncInputSchema.safeParse({ ...old, douyin: { status: 'ok', profile: { ...profile(), status: 'snapshot' } } }).success).toBe(false);
  });
});
