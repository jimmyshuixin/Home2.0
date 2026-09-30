import { describe, expect, it } from 'vitest';
import { projectPublicNow, projectPublicTopics, SiteSettingsSchema } from '../src';
const timestamp = '2026-09-30T08:00:00.000Z';
describe('Now public projection', () => {
  it('does not introduce a field or copy existing settings without Now', () => {
    const settings = SiteSettingsSchema.parse({ intro: '原有简介' });
    expect(settings).not.toHaveProperty('now');
    expect(projectPublicTopics(settings, { creations: [], albums: [] })).toBe(settings);
  });
  it.each([
    { enabled: false, text: '私密近况草稿', updatedAt: timestamp },
    { enabled: true, text: ' ', updatedAt: timestamp },
    { enabled: true, text: '尚无真实更新时间', updatedAt: null },
  ])('removes unpublished Now text from the full public object (%j)', now => {
    const settings = SiteSettingsSchema.parse({ now });
    const projected = projectPublicTopics(settings, { creations: [], albums: [] });
    expect(projected).not.toHaveProperty('now');
    expect(JSON.stringify(projected)).not.toContain(now.text.trim() || timestamp);
    expect(settings.now).toEqual({ ...now, text: now.text.trim() });
  });
  it('preserves only the explicit, nonempty and dated public update', () => {
    const settings = SiteSettingsSchema.parse({ now: { enabled: true, text: '最近在整理照片。', updatedAt: timestamp } });
    expect(projectPublicNow(settings)).toBe(settings);
    expect(projectPublicTopics(settings, { creations: [], albums: [] }).now).toEqual(settings.now);
  });
  it.each(['2026-09-30', '<p>近况</p>', 'not-a-date'])('rejects malformed timestamps (%s)', updatedAt => {
    expect(SiteSettingsSchema.safeParse({ now: { enabled: true, text: '近况', updatedAt } }).success).toBe(false);
  });
  it('does not admit extra private fields into Now', () => {
    expect(SiteSettingsSchema.safeParse({ now: { enabled: false, text: '', privateNote: '秘密' } }).success).toBe(false);
  });
});
