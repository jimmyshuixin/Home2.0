import { defineComponent, h, type PropType, type VNodeChild } from 'vue';
import type { RichTextDocument } from '@xvyin/contracts';
import { safePreviewLink } from '../media';

interface Node { type: string; text?: string; content?: Node[]; attrs?: { level?: number; start?: number }; marks?: { type: string; attrs?: { href?: string; title?: string } }[] }
function render(node: Node): VNodeChild {
  if (node.type === 'text') {
    let output: VNodeChild = node.text || '';
    for (const mark of node.marks || []) {
      if (mark.type === 'link') { const href = safePreviewLink(mark.attrs?.href); if (href) output = h('a', { href, title: mark.attrs?.title, target: '_blank', rel: 'noopener noreferrer' }, [output]); }
      else { const tag = ({ bold: 'strong', italic: 'em', strike: 's', code: 'code' } as Record<string, string>)[mark.type]; if (tag) output = h(tag, [output]); }
    }
    return output;
  }
  if (node.type === 'hardBreak') return h('br');
  const children = (node.content || []).map(render);
  const tag = ({ paragraph: 'p', bulletList: 'ul', orderedList: 'ol', listItem: 'li' } as Record<string, string>)[node.type];
  if (tag) return h(tag, node.type === 'orderedList' ? { start: node.attrs?.start } : {}, children);
  if (node.type === 'heading') return h(`h${Math.max(2, Math.min(6, node.attrs?.level || 2))}`, children);
  return children;
}
export default defineComponent({ name: 'DraftRichText', props: { document: { type: Object as PropType<RichTextDocument>, required: true } }, setup(props) { return () => h('div', { class: 'draft-richtext' }, [render(props.document)]); } });
