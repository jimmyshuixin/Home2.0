import type { RichHeading, RichTextDocument } from '@xvyin/contracts'

export interface RichTextOutlineItem { id: string; label: string; level: number }

/** Matches the public renderer: the article title owns h1. */
export function publicHeadingLevel(level: number): number { return Math.max(2, Math.min(6, level)) }

/** Block IDs are unique in the content contract. Node positions also distinguish repeated/empty headings. */
export function richTextHeadingId(blockId: string, nodeIndex: number): string {
  return `heading-${blockId}-${nodeIndex + 1}`
}

function headingLabel(node: RichHeading): string {
  return node.content.map(child => child.type === 'text' ? child.text : ' ').join('').replace(/\s+/gu, ' ').trim() || '未命名标题'
}

export function richTextOutline(blocks: readonly { id: string; type: string; document?: RichTextDocument }[]): RichTextOutlineItem[] {
  return blocks.flatMap(block => block.type === 'richtext' && block.document
    ? block.document.content.flatMap((node, index) => node.type === 'heading'
      ? [{ id: richTextHeadingId(block.id, index), label: headingLabel(node), level: publicHeadingLevel(node.attrs.level) }]
      : [])
    : [])
}
