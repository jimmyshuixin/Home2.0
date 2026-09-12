import { defineComponent, h, type PropType, type VNodeChild } from 'vue'
import { safeUrl, type RichNode } from '~/lib/site'
import type { RichTextDocument } from '@xvyin/contracts'

function render(node: RichNode): VNodeChild {
  if (node.type === 'text') {
    let output: VNodeChild = node.text || ''
    for (const mark of node.marks || []) {
      if (mark.type === 'link') { const href = safeUrl(mark.attrs.href); if (href) output = h('a', { href, title: mark.attrs.title, rel: 'noopener noreferrer' }, [output]) }
      else { const tag = ({ bold: 'strong', italic: 'em', strike: 's', code: 'code' } as Record<string, string>)[mark.type]; if (tag) output = h(tag, [output]) }
    }
    return output
  }
  if (node.type === 'hardBreak') return h('br')
  const children = node.content.map(render)
  switch (node.type) {
    case 'doc': return children
    case 'paragraph': return h('p', children)
    case 'heading': return h(`h${Math.max(2, node.attrs.level)}`, children)
    case 'bulletList': return h('ul', children)
    case 'orderedList': return h('ol', { start: node.attrs?.start }, children)
    case 'listItem': return h('li', children)
  }
}
export default defineComponent({
  name: 'RichText', props: { document: { type: Object as PropType<RichTextDocument>, required: true } },
  setup(props) { return () => h('div', { class: 'richtext' }, [render(props.document)]) }
})
