import { describe, expect, it } from 'vitest';
import { SiteSettingsSchema, SiteSettingsInputSchema } from '../src';

describe('about-page platform visibility', () => {
  it('keeps every platform visible for existing records without the new field', () => {
    const previous = { intro: 'Existing public introduction', socialLinks: [{ id: 'external-link', label: 'Contact', url: 'https://example.com' }] };
    expect(SiteSettingsSchema.parse(previous)).toMatchObject({ ...previous, socialVisibility: { bilibili: true, douyin: true, github: true } });
    expect(previous).not.toHaveProperty('socialVisibility');
  });
  it('supports independent hiding and partial records without changing a saved false value', () => {
    expect(SiteSettingsSchema.parse({ socialVisibility: { douyin: false } }).socialVisibility).toEqual({ bilibili: true, douyin: false, github: true });
    expect(SiteSettingsInputSchema.parse({ expectedVersion: 3, socialVisibility: { bilibili: false, douyin: false, github: false } }).socialVisibility).toEqual({ bilibili: false, douyin: false, github: false });
  });
  it.each([null, false, [], { bilibili: 'false' }, { github: 0 }, { douyin: null }, { youtube: true }])('rejects malformed visibility instead of coercing it (%j)', socialVisibility => {
    expect(SiteSettingsSchema.safeParse({ socialVisibility }).success).toBe(false);
  });
});
