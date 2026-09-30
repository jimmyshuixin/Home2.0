import { describe, expect, it } from 'vitest';
import { CreationDraftSchema, PublishableCreationSchema } from '@xvyin/contracts';
import { ensureNoteIdentity, newNoteDraft } from '../src/notes';
const now = new Date('2026-09-29T16:30:00.000Z');
describe('quick note identity and publishing', () => {
  it('creates a Shanghai-dated identity without asking for a title', () => {
    const note = newNoteDraft('a-note-id', now);
    expect(note).toMatchObject({ kind: 'note', title: '随记 2026.09.30', slug: 'note-20260930-anoteid' });
    expect(CreationDraftSchema.safeParse(note).success).toBe(true);
    expect(PublishableCreationSchema.safeParse(note).success).toBe(false);
  });
  it('keeps links and titles stable after further editing and recovery', () => {
    const note = newNoteDraft('original-id', now);
    const restored = JSON.parse(JSON.stringify(note));
    restored.blocks[0].document.content[0].content = [{ type: 'text', text: '真实的一小段文字。' }];
    expect(ensureNoteIdentity(restored, 'new-browser-session', new Date('2027-01-01T01:00:00Z'))).toMatchObject({ title: note.title, slug: note.slug });
    expect(PublishableCreationSchema.safeParse(restored).success).toBe(true);
  });
  it('permits an image-only note and gives simultaneous notes distinct slugs', () => {
    const note = newNoteDraft('first-id', now);
    note.blocks = [{ id: 'image-block', type: 'image', assetId: 'real-image', variantRole: 'content', alt: '雨后的街道', caption: '', alignment: 'center' }];
    expect(PublishableCreationSchema.safeParse(note).success).toBe(true);
    expect(note.slug).not.toEqual(newNoteDraft('second-id', now).slug);
  });
  it('does not alter existing article data', () => {
    const draft = CreationDraftSchema.parse({ kind: 'article' });
    expect(ensureNoteIdentity(draft, 'id', now)).toBe(draft);
  });
});
