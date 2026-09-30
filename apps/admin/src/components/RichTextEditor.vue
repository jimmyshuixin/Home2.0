<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { Editor, Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Fragment, Slice } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { RichTextDocumentSchema, SafeHrefSchema, type RichTextDocument } from '@xvyin/contracts';
import { compatibleExtensions, fromEditorDocument, toEditorDocument } from '../richtext-compatibility';
import { plainTextParagraphs } from '../plain-text';
const props = defineProps<{ modelValue: RichTextDocument; label?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: RichTextDocument] }>();
const surface = ref<HTMLElement>(), issue = ref(''), link = ref(''), ready = ref(false), change = ref(0), linkId = useId();
let editor: Editor | undefined, lastEmitted = '', destroyed = false;
function rejected() { issue.value = '这次修改超出现有内容格式或长度限制，原文已保留。'; }
function publish() {
  if (!editor || editor.isDestroyed || editor.view.composing) return;
  try { const value = fromEditorDocument(editor.getJSON()); lastEmitted = JSON.stringify(value); issue.value = ''; emit('update:modelValue', value); change.value++; }
  catch { rejected(); }
}
function load(value: RichTextDocument) {
  if (!surface.value) return;
  try {
    const content = toEditorDocument(value);
    editor?.destroy();
    editor = new Editor({ element: surface.value, content, extensions: [...compatibleExtensions(), Extension.create({ name: 'contractGuard', addProseMirrorPlugins() { return [new Plugin({ filterTransaction(transaction) { if (!transaction.docChanged) return true; try { fromEditorDocument(transaction.doc.toJSON()); return true; } catch { rejected(); return false; } } })]; } })],
      enableInputRules: false, enablePasteRules: false,
      editorProps: { attributes: { role: 'textbox', 'aria-label': props.label || '正文富文本', 'aria-multiline': 'true', spellcheck: 'false' },
        handlePaste(view, event) {
          event.preventDefault(); const text = event.clipboardData?.getData('text/plain') || ''; if (!text) return true;
          try { const paragraphs = plainTextParagraphs(text); RichTextDocumentSchema.parse({ type: 'doc', content: paragraphs }); const nodes = paragraphs.map(node => view.state.schema.nodeFromJSON(node)); view.dispatch(closeHistory(view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 1, 1))).setMeta('uiEvent', 'paste').scrollIntoView()); view.dispatch(closeHistory(view.state.tr)); }
          catch { rejected(); } return true;
        },
        handleDOMEvents: { compositionend() { queueMicrotask(() => { if (!destroyed) publish(); }); return false; } },
      },
      onUpdate: publish, onSelectionUpdate: () => { change.value++; },
    });
    lastEmitted = JSON.stringify(value); ready.value = true; issue.value = ''; change.value++;
  } catch { issue.value = '这份正文无法安全载入编辑器，原始内容已保留。请先导出草稿，再检查内容格式。'; ready.value = false; }
}
function command(action: (value: Editor) => void) { if (!editor || editor.view.composing || !ready.value) return; action(editor); change.value++; }
function active(type: string, attributes?: Record<string, unknown>) { void change.value; return editor?.isActive(type, attributes) || false; }
function applyLink() { const parsed = SafeHrefSchema.safeParse(link.value); if (!parsed.success) { issue.value = '请输入 HTTPS 地址、站内路径或标题锚点。'; return; } if (!editor || editor.state.selection.empty) { issue.value = '请先选中需要链接的文字。'; return; } command(value => { value.chain().focus().setMark('link', { href: parsed.data }).run(); }); link.value = ''; }
watch(() => props.modelValue, value => { if (JSON.stringify(value) !== lastEmitted) load(value); }, { deep: true });
onMounted(() => load(props.modelValue)); onBeforeUnmount(() => { destroyed = true; editor?.destroy(); });
</script>
<template><div class="rich-editor"><div class="rich-toolbar" aria-label="文字格式" @mousedown.prevent>
  <button type="button" :disabled="!ready" :aria-pressed="active('bold')" aria-label="加粗选中文字" @click="command(e => { e.chain().focus().toggleBold().run() })"><strong>B</strong></button>
  <button type="button" :disabled="!ready" :aria-pressed="active('italic')" aria-label="斜体选中文字" @click="command(e => { e.chain().focus().toggleItalic().run() })"><em>I</em></button>
  <button type="button" :disabled="!ready" :aria-pressed="active('strike')" @click="command(e => { e.chain().focus().toggleStrike().run() })">删除线</button>
  <button type="button" :disabled="!ready" :aria-pressed="active('code')" @click="command(e => { e.chain().focus().toggleMark('code').run() })">代码</button>
  <button type="button" :disabled="!ready" @click="command(e => { e.chain().focus().setParagraph().run() })">正文</button>
  <button type="button" :disabled="!ready" :aria-pressed="active('heading', {level:2})" @click="command(e => { e.chain().focus().toggleHeading({level:2}).run() })">二级标题</button>
  <button type="button" :disabled="!ready" :aria-pressed="active('heading', {level:3})" @click="command(e => { e.chain().focus().toggleHeading({level:3}).run() })">三级标题</button>
  <button type="button" :disabled="!ready" :aria-pressed="active('bulletList')" @click="command(e => { e.chain().focus().toggleBulletList().run() })">无序列表</button>
  <button type="button" :disabled="!ready" :aria-pressed="active('orderedList')" @click="command(e => { e.chain().focus().toggleOrderedList().run() })">有序列表</button>
  <button type="button" :disabled="!ready" @click="command(e => { e.chain().focus().undo().run() })">撤销</button><button type="button" :disabled="!ready" @click="command(e => { e.chain().focus().redo().run() })">重做</button>
</div><div ref="surface" class="rich-surface tiptap-surface"/><p v-if="!ready" class="hint">正文保持原样，其他资料仍可编辑。</p><div class="rich-link"><label :for="linkId" class="sr-only">链接地址</label><input :id="linkId" v-model="link" placeholder="https:// 或站内路径"><button type="button" :disabled="!ready" @mousedown.prevent @click="applyLink">插入链接</button><button type="button" :disabled="!ready" @mousedown.prevent @click="command(e => { e.chain().focus().unsetMark('link').run() })">移除链接</button></div><p v-if="issue" class="notice error mt8" role="alert">{{issue}}</p><p class="hint mt8">支持撤销与重做；粘贴为纯文本。列表内按 Tab 缩进，Shift + Tab 取消缩进。</p></div></template>
<style scoped>.tiptap-surface{padding:0}.tiptap-surface :deep(.tiptap){min-height:180px;padding:16px;outline:none;white-space:pre-wrap;overflow-wrap:anywhere}.tiptap-surface :deep(.tiptap:focus){box-shadow:inset 0 0 0 2px var(--green);border-radius:4px}.rich-toolbar{flex-wrap:wrap}.rich-toolbar button[aria-pressed=true]{background:var(--green);color:white}.rich-link{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.rich-link input{flex:1;min-width:160px}.tiptap-surface :deep(ul),.tiptap-surface :deep(ol){padding-left:1.8em}</style>
