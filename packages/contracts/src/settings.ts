import { z } from 'zod';
import { HttpsUrlSchema, IdSchema, plainText, requireUniqueIds, SlugSchema, SortOrderSchema, UtcTimestampSchema, VersionSchema } from './common';
import { RichTextDocumentSchema } from './content';
import { HERO_TITLE } from './limits';

export const NavigationHrefSchema = z.enum(['/about', '/creations', '/photography', '/fitness', '/#guestbook', '/contact']);
export const NavigationItemSchema = z.object({
  label: plainText(20, 1), href: NavigationHrefSchema, enabled: z.boolean().default(true), sortOrder: SortOrderSchema,
}).strict();
export const DEFAULT_NAVIGATION = [
  { label: '关于', href: '/about', enabled: true, sortOrder: 0 },
  { label: '创作', href: '/creations', enabled: true, sortOrder: 1 },
  { label: '摄影', href: '/photography', enabled: true, sortOrder: 2 },
  { label: '健身', href: '/fitness', enabled: true, sortOrder: 3 },
  { label: '留言', href: '/#guestbook', enabled: true, sortOrder: 4 },
  { label: '联系', href: '/contact', enabled: true, sortOrder: 5 },
] satisfies z.infer<typeof NavigationItemSchema>[];

export const SocialLinkSchema = z.object({ id: IdSchema, label: plainText(40, 1), url: HttpsUrlSchema }).strict();
export const SocialVisibilitySchema = z.object({
  bilibili: z.boolean().default(true), douyin: z.boolean().default(true), github: z.boolean().default(true),
}).strict();
export type SocialVisibility = z.infer<typeof SocialVisibilitySchema>;
export const TOPIC_LIMITS = { topics: 24, members: 100 } as const;
export const TopicMemberSchema = z.object({ collection: z.enum(['creations', 'albums']), id: IdSchema }).strict();
export const TopicSchema = z.object({
  id: IdSchema, slug: SlugSchema, title: plainText(120, 1), intro: plainText(2000).default(''),
  enabled: z.boolean().default(false), members: z.array(TopicMemberSchema).max(TOPIC_LIMITS.members).default([]),
}).strict().superRefine((topic, ctx) => {
  const seen = new Set<string>();
  topic.members.forEach((member, index) => {
    const key = `${member.collection}/${member.id}`;
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['members', index], message: '同一内容在专题中不可重复' });
    seen.add(key);
  });
});
export type Topic = z.infer<typeof TopicSchema>;
export type TopicMember = z.infer<typeof TopicMemberSchema>;
export const NowSchema = z.object({
  enabled: z.boolean().default(false),
  text: plainText(2000).default(''),
  updatedAt: UtcTimestampSchema.nullable().default(null),
}).strict();
export type Now = z.infer<typeof NowSchema>;
const settingsShape = {
  siteTitle: plainText(80, 1).default('虚宁的个人网站'),
  // Read existing V3 records without rewriting immutable published snapshots.
  // Only the exact previous title is compatible; all other spellings stay invalid.
  heroTitle: z.union([z.literal(HERO_TITLE), z.literal('hello！i‘m 虚宁')]).transform(() => HERO_TITLE).default(HERO_TITLE),
  intro: plainText(2000).default(''),
  about: RichTextDocumentSchema.default({ type: 'doc', content: [] }),
  avatarAssetId: IdSchema.nullable().default(null),
  socialLinks: z.array(SocialLinkSchema).max(20).default([]),
  socialVisibility: SocialVisibilitySchema.default({ bilibili: true, douyin: true, github: true }),
  navigation: z.array(NavigationItemSchema).max(6).default(DEFAULT_NAVIGATION),
  themePreference: z.enum(['system', 'light', 'dark']).default('system'),
  contactEnabled: z.boolean().default(true),
  footerText: plainText(500).default(''),
  // Optional preserves the serialized shape of existing immutable releases.
  topics: z.array(TopicSchema).max(TOPIC_LIMITS.topics).optional(),
  now: NowSchema.optional(),
};
function validateSettings(value: { navigation: { href: string }[]; socialLinks: { id: string }[]; topics?: Topic[] }, ctx: z.RefinementCtx) {
  if (new Set(value.navigation.map(item => item.href)).size !== value.navigation.length) {
    ctx.addIssue({ code: 'custom', path: ['navigation'], message: '导航地址不可重复' });
  }
  requireUniqueIds(value.socialLinks, ctx, ['socialLinks']);
  requireUniqueIds(value.topics || [], ctx, ['topics']);
  const slugs = new Set<string>();
  value.topics?.forEach((topic, index) => {
    if (slugs.has(topic.slug)) ctx.addIssue({ code: 'custom', path: ['topics', index, 'slug'], message: '专题链接名称不可重复' });
    slugs.add(topic.slug);
  });
}
export const SiteSettingsSchema = z.object(settingsShape).strict().superRefine(validateSettings);
export const SiteSettingsInputSchema = z.object({ ...settingsShape, expectedVersion: VersionSchema }).strict().superRefine(validateSettings);
export type SiteSettings = z.infer<typeof SiteSettingsSchema>;
export type SiteSettingsInput = z.infer<typeof SiteSettingsInputSchema>;

/** Project only against the selected immutable release, never mutable draft visibility. */
export function projectPublicTopics(settings: SiteSettings, published: { creations: readonly { id: string }[]; albums: readonly { id: string }[] }): SiteSettings {
  const publicSettings = projectPublicNow(settings);
  if (!settings.topics) return publicSettings;
  const available = { creations: new Set(published.creations.map(item => item.id)), albums: new Set(published.albums.map(item => item.id)) };
  return { ...publicSettings, topics: settings.topics.filter(topic => topic.enabled).map(topic => ({
    ...topic, members: topic.members.filter(member => available[member.collection].has(member.id)),
  })).filter(topic => topic.members.length > 0) };
}

/** Disabled and empty Now drafts never cross the immutable public boundary. */
export function projectPublicNow(settings: SiteSettings): SiteSettings {
  if (!settings.now || (settings.now.enabled && settings.now.text.trim() && settings.now.updatedAt)) return settings;
  const { now: _now, ...publicSettings } = settings;
  return publicSettings;
}
