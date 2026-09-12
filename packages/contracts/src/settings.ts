import { z } from 'zod';
import { HttpsUrlSchema, IdSchema, plainText, requireUniqueIds, SortOrderSchema, VersionSchema } from './common';
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
const settingsShape = {
  siteTitle: plainText(80, 1).default('虚宁的个人网站'),
  heroTitle: z.literal(HERO_TITLE).default(HERO_TITLE),
  intro: plainText(2000).default(''),
  about: RichTextDocumentSchema.default({ type: 'doc', content: [] }),
  avatarAssetId: IdSchema.nullable().default(null),
  socialLinks: z.array(SocialLinkSchema).max(20).default([]),
  navigation: z.array(NavigationItemSchema).max(6).default(DEFAULT_NAVIGATION),
  themePreference: z.enum(['system', 'light', 'dark']).default('system'),
  contactEnabled: z.boolean().default(true),
  footerText: plainText(500).default(''),
};
function validateSettings(value: { navigation: { href: string }[]; socialLinks: { id: string }[] }, ctx: z.RefinementCtx) {
  if (new Set(value.navigation.map(item => item.href)).size !== value.navigation.length) {
    ctx.addIssue({ code: 'custom', path: ['navigation'], message: '导航地址不可重复' });
  }
  requireUniqueIds(value.socialLinks, ctx, ['socialLinks']);
}
export const SiteSettingsSchema = z.object(settingsShape).strict().superRefine(validateSettings);
export const SiteSettingsInputSchema = z.object({ ...settingsShape, expectedVersion: VersionSchema }).strict().superRefine(validateSettings);
export type SiteSettings = z.infer<typeof SiteSettingsSchema>;
export type SiteSettingsInput = z.infer<typeof SiteSettingsInputSchema>;
