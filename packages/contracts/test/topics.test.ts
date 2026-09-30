import { describe, expect, it } from 'vitest';
import { projectPublicTopics, SiteSettingsSchema, TOPIC_LIMITS, TopicSchema } from '../src';

const topic = { id: 'topic', slug: 'a-journey', title: '一段旅程', intro: '文字与影像', enabled: true, members: [{ collection: 'albums' as const, id: 'album' }, { collection: 'creations' as const, id: 'article' }] };
describe('bounded ordered topic contract', () => {
  it('preserves old settings without adding a topics field', () => {
    const settings = SiteSettingsSchema.parse({ intro: 'Existing' });
    expect(settings).not.toHaveProperty('topics');
    expect(projectPublicTopics(settings, { creations: [], albums: [] })).toBe(settings);
  });
  it('preserves topic/member order and permits the same id in different collections', () => {
    expect(TopicSchema.parse(topic).members).toEqual(topic.members);
    expect(TopicSchema.parse({ ...topic, members: [{ collection: 'albums', id: 'shared' }, { collection: 'creations', id: 'shared' }] }).members).toHaveLength(2);
  });
  it('rejects duplicate topic IDs, slugs and members', () => {
    for (const second of [{ ...topic, slug: 'other' }, { ...topic, id: 'other' }]) expect(SiteSettingsSchema.safeParse({ topics: [topic, second] }).success).toBe(false);
    expect(TopicSchema.safeParse({ ...topic, members: [topic.members[0], topic.members[0]] }).success).toBe(false);
  });
  it('rejects unsafe slugs, copied member metadata and unsupported collections', () => {
    for (const slug of ['../draft', 'Draft', 'two/parts', 'space here']) expect(TopicSchema.safeParse({ ...topic, slug }).success).toBe(false);
    expect(TopicSchema.safeParse({ ...topic, members: [{ collection: 'creations', id: 'article', title: 'Private draft' }] }).success).toBe(false);
    expect(TopicSchema.safeParse({ ...topic, members: [{ collection: 'media', id: 'original' }] }).success).toBe(false);
  });
  it('bounds configuration before it reaches release preparation', () => {
    expect(SiteSettingsSchema.safeParse({ topics: Array.from({ length: TOPIC_LIMITS.topics + 1 }, (_, i) => ({ ...topic, id: `t${i}`, slug: `t${i}` })) }).success).toBe(false);
    expect(TopicSchema.safeParse({ ...topic, members: Array.from({ length: TOPIC_LIMITS.members + 1 }, (_, i) => ({ collection: 'creations', id: `m${i}` })) }).success).toBe(false);
  });
  it('removes private references and disabled or empty topics without mutating the draft', () => {
    const settings = SiteSettingsSchema.parse({ topics: [topic, { ...topic, id: 'disabled', slug: 'private-topic', title: 'Private title', enabled: false }, { ...topic, id: 'empty', slug: 'empty-topic', members: [{ collection: 'creations', id: 'unpublished-id' }] }] });
    const before = JSON.stringify(settings);
    const result = projectPublicTopics(settings, { creations: [{ id: 'article' }], albums: [] });
    expect(result.topics).toEqual([{ ...topic, members: [topic.members[1]] }]);
    expect(JSON.stringify(result)).not.toContain('unpublished-id');
    expect(JSON.stringify(result)).not.toContain('Private title');
    expect(JSON.stringify(settings)).toBe(before);
  });
});
