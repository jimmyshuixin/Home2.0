import type { RichInline, RichParagraph } from '@xvyin/contracts';

/** Clipboard text uses the same explicit paragraphs and breaks as the renderer. */
export function plainTextParagraphs(text: string): RichParagraph[] {
  return text.replace(/\r\n?/g, '\n').split(/\n[\t ]*\n/).map(paragraph => {
    const content: RichInline[] = [];
    paragraph.split('\n').forEach((line, index) => {
      if (index) content.push({ type: 'hardBreak' });
      if (line) content.push({ type: 'text', text: line });
    });
    return { type: 'paragraph', content };
  });
}
