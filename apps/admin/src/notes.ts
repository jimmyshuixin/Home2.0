import { CreationDraftSchema, type CreationDraft } from '@xvyin/contracts';

function noteDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Generate once, then retain the same identity through edits and restores. */
export function ensureNoteIdentity(draft: CreationDraft, id: string, now: Date): CreationDraft {
  if (draft.kind !== 'note') return draft;
  const day = noteDay(now);
  return {
    ...draft,
    title: draft.title || `随记 ${day.replaceAll('-', '.')}`,
    slug: draft.slug || `note-${day.replaceAll('-', '')}-${id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32)}`,
  };
}

export function newNoteDraft(id: string, now: Date): CreationDraft {
  return ensureNoteIdentity(CreationDraftSchema.parse({ kind: 'note', blocks: [{
    id: `text-${id}`, type: 'richtext', document: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
  }] }), id, now);
}
