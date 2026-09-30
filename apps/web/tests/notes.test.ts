import { describe, expect, it } from 'vitest';
import { CreationDraftSchema } from '@xvyin/contracts';
import type { Creation } from '../lib/models';
import { noteDate, publishedNotes, visibleNow } from '../lib/notes';
function entry(id: string, kind: 'note' | 'article', publishedAt: string): Creation { return { ...CreationDraftSchema.parse({ kind, title: id, slug: id }), id, revisionId: `revision-${id}`, publishedAt }; }
describe('public notes and Now', () => {
  it('selects notes in reverse chronological order without mutating the release', () => {
    const notes = [entry('old', 'note', '2026-09-29T01:00:00Z'), entry('article', 'article', '2026-09-30T01:00:00Z'), entry('new', 'note', '2026-09-30T01:00:00Z')];
    expect(publishedNotes(notes).map(item => item.id)).toEqual(['new', 'old']);
    expect(notes.map(item => item.id)).toEqual(['old', 'article', 'new']);
  });
  it('uses Shanghai dates at the UTC day boundary', () => {
    expect(noteDate('2026-09-29T16:30:00Z')).toBe('2026年9月30日');
    expect(noteDate('not-a-date')).toBe('');
  });
  it('renders an empty state for absent, disabled or undated Now', () => {
    expect(visibleNow({})).toBeNull();
    expect(visibleNow({ now: { enabled: false, text: '未公开', updatedAt: '2026-09-30T00:00:00Z' } })).toBeNull();
    expect(visibleNow({ now: { enabled: true, text: '未标注更新', updatedAt: null } })).toBeNull();
  });
});
