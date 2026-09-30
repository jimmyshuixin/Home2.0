import { defineComponent, h, type PropType } from 'vue'
import { safeUrl } from '~/lib/site'
import type { RichTextDocument } from '@xvyin/contracts'
import { renderRichText } from '../lib/richtext-render'
export default defineComponent({
  name: 'RichText', props: { document: { type: Object as PropType<RichTextDocument>, required: true }, blockId: String },
  setup(props) { return () => h('div', { class: 'richtext' }, renderRichText(props.document, safeUrl, props.blockId)) }
})
