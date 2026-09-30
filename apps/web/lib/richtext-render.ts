import { h, type VNodeChild } from 'vue'
import type { RichTextDocument } from '@xvyin/contracts'
import type { RichNode } from './models'
import { publicHeadingLevel, richTextHeadingId } from './richtext-outline'

/** Shared pure renderer; no snapshot, drafts or browser state is imported. */
export function renderRichText(document: RichTextDocument, safeUrl: (value?: string | null) => string | undefined, blockId?: string): VNodeChild[] {
  function render(node: RichNode, headingId?: string): VNodeChild {
    if (node.type === 'text') {
      let output: VNodeChild = node.text || ''
      for (const mark of node.marks || []) {
        if (mark.type === 'link') { const href = safeUrl(mark.attrs.href); if (href) output = h('a', { href, title: mark.attrs.title, rel: 'noopener noreferrer' }, [output]) }
        else { const tag = ({ bold: 'strong', italic: 'em', strike: 's', code: 'code' } as Record<string, string>)[mark.type]; if (tag) output = h(tag, [output]) }
      }
      return output
    }
    if (node.type === 'hardBreak') return h('br')
    const children = node.content.map(child => render(child))
    switch (node.type) {
      case 'doc': return children
      case 'paragraph': return h('p', children)
      case 'heading': return h(`h${publicHeadingLevel(node.attrs.level)}`, { id: headingId }, children)
      case 'bulletList': return h('ul', children)
      case 'orderedList': return h('ol', { start: node.attrs?.start }, children)
      case 'listItem': return h('li', children)
    }
  }
  return document.content.map((node, index) => render(node, blockId && node.type === 'heading' ? richTextHeadingId(blockId, index) : undefined))
}
