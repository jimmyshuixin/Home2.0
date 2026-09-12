<script setup lang="ts">
import { onMounted, ref, watch, useId } from 'vue';
import { SafeHrefSchema, type RichTextDocument, type RichInline, type RichTextMark, type RichParagraph, type RichList } from '@xvyin/contracts';
const props = defineProps<{ modelValue: RichTextDocument; label?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: RichTextDocument] }>();
const editor = ref<HTMLDivElement>();
const link = ref('');
const issue = ref('');
const linkId = useId();
let selection: Range | null = null;
let lastValue = '';

function inlineNodes(nodes: RichInline[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const node of nodes) {
    if (node.type === 'hardBreak') { fragment.append(document.createElement('br')); continue; }
    let element: Node = document.createTextNode(node.text);
    for (const mark of node.marks ?? []) {
      const tag = ({ bold: 'strong', italic: 'em', strike: 's', code: 'code', link: 'a' })[mark.type];
      const wrapper = document.createElement(tag);
      if (mark.type === 'link') wrapper.setAttribute('href', mark.attrs.href);
      wrapper.append(element); element = wrapper;
    }
    fragment.append(element);
  }
  return fragment;
}
function blockNode(node: RichTextDocument['content'][number]): HTMLElement {
  if (node.type === 'paragraph' || node.type === 'heading') {
    const element = document.createElement(node.type === 'paragraph' ? 'p' : `h${node.attrs.level}`);
    element.append(inlineNodes(node.content)); if (!node.content.length) element.append(document.createElement('br')); return element;
  }
  const list = document.createElement(node.type === 'orderedList' ? 'ol' : 'ul');
  if (node.type === 'orderedList' && node.attrs?.start) list.setAttribute('start', String(node.attrs.start));
  for (const item of node.content) { const li = document.createElement('li'); item.content.forEach(child => li.append(blockNode(child))); list.append(li); }
  return list;
}
function render() {
  if (!editor.value) return;
  const value = JSON.stringify(props.modelValue);
  if (value === lastValue) return;
  lastValue = value;
  editor.value.replaceChildren(...props.modelValue.content.map(blockNode));
  if (!editor.value.childNodes.length) editor.value.append(blockNode({ type: 'paragraph', content: [] }));
}
function parseInline(nodes: NodeListOf<ChildNode> | ChildNode[], marks: RichTextMark[] = []): RichInline[] {
  const out: RichInline[] = [];
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) { if (node.textContent) out.push({ type: 'text', text: node.textContent, ...(marks.length ? { marks } : {}) }); continue; }
    if (!(node instanceof HTMLElement)) continue;
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].includes(node.tagName)) continue;
    if (node.tagName === 'BR') { out.push({ type: 'hardBreak' }); continue; }
    const nextMarks = [...marks];
    const type = ({ STRONG: 'bold', B: 'bold', EM: 'italic', I: 'italic', S: 'strike', STRIKE: 'strike', CODE: 'code' } as const)[node.tagName as 'STRONG'];
    if (type && !nextMarks.some(mark => mark.type === type)) nextMarks.push({ type });
    if (node.tagName === 'A') { const parsed = SafeHrefSchema.safeParse(node.getAttribute('href')); if (parsed.success && !nextMarks.some(mark => mark.type === 'link')) nextMarks.push({ type: 'link', attrs: { href: parsed.data } }); }
    out.push(...parseInline(node.childNodes, nextMarks));
  }
  return out;
}
function parseBlocks(nodes: NodeListOf<ChildNode>): RichTextDocument['content'] {
  const out: RichTextDocument['content'] = [];
  let pending: ChildNode[] = [];
  const flush = () => { if (pending.length) { const content = parseInline(pending); if (content.length) out.push({ type: 'paragraph', content }); pending = []; } };
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) { pending.push(node); continue; }
    if (/^H[1-6]$/.test(node.tagName)) { flush(); out.push({ type: 'heading', attrs: { level: Number(node.tagName.slice(1)) }, content: parseInline(node.childNodes) }); }
    else if (node.tagName === 'UL' || node.tagName === 'OL') {
      flush(); const content = Array.from(node.children).filter(child => child.tagName === 'LI').map(li => ({ type: 'listItem' as const, content: parseBlocks(li.childNodes).filter((child): child is RichParagraph | RichList => child.type !== 'heading') }));
      content.forEach(item => { if (!item.content.length) item.content.push({ type: 'paragraph', content: [] }); });
      if (content.length) out.push(node.tagName === 'UL' ? { type: 'bulletList', content } : { type: 'orderedList', attrs: { start: Math.max(1, Number(node.getAttribute('start')) || 1) }, content });
    } else if (['P', 'DIV'].includes(node.tagName)) { flush(); if (Array.from(node.children).some(child => ['P', 'DIV', 'UL', 'OL'].includes(child.tagName))) out.push(...parseBlocks(node.childNodes)); else out.push({ type: 'paragraph', content: parseInline(node.childNodes) }); }
    else pending.push(node);
  }
  flush(); return out;
}
function update() {
  if (!editor.value) return;
  const value: RichTextDocument = { type: 'doc', content: parseBlocks(editor.value.childNodes) };
  lastValue = JSON.stringify(value); emit('update:modelValue', value); remember();
}
function remember() {
  const active = window.getSelection();
  if (active?.rangeCount && editor.value?.contains(active.anchorNode)) selection = active.getRangeAt(0).cloneRange();
}
function restore() {
  if (!editor.value) return null;
  editor.value.focus();
  if (!selection || !editor.value.contains(selection.commonAncestorContainer)) { selection = document.createRange(); selection.selectNodeContents(editor.value); selection.collapse(false); }
  const active = window.getSelection(); active?.removeAllRanges(); active?.addRange(selection); return selection;
}
function mark(tag: string, href?: string) {
  const range = restore(); if (!range || range.collapsed) { issue.value = '请先选中需要格式化的文字。'; return; }
  const wrapper = document.createElement(tag); if (href) wrapper.setAttribute('href', href);
  wrapper.append(range.extractContents()); range.insertNode(wrapper); range.selectNodeContents(wrapper); issue.value = ''; update();
}
function applyLink() { const parsed = SafeHrefSchema.safeParse(link.value); if (!parsed.success) { issue.value = '请输入有效的 https 链接或站内路径。'; return; } mark('a', parsed.data); link.value = ''; }
function format(tag: string) {
  const range = restore(); if (!range || !editor.value) return;
  let node: HTMLElement | null = range.startContainer instanceof HTMLElement ? range.startContainer : range.startContainer.parentElement;
  while (node && node.parentElement !== editor.value) node = node.parentElement;
  if (!node || node === editor.value) return;
  const replacement = document.createElement(tag);
  if (tag === 'ul' || tag === 'ol') { const li = document.createElement('li'); const p = document.createElement('p'); p.append(...Array.from(node.childNodes)); li.append(p); replacement.append(li); }
  else replacement.append(...Array.from(node.childNodes));
  node.replaceWith(replacement); selection = document.createRange(); selection.selectNodeContents(replacement); selection.collapse(false); restore(); update();
}
function paste(event: ClipboardEvent) {
  event.preventDefault(); const value = event.clipboardData?.getData('text/plain') ?? ''; const range = restore(); if (!range) return;
  range.deleteContents(); const text = document.createTextNode(value); range.insertNode(text); range.setStartAfter(text); range.collapse(true); update();
}
onMounted(render); watch(() => props.modelValue, render, { deep: true });
</script>
<template><div class="rich-editor"><div class="rich-toolbar" @mousedown.prevent><button type="button" aria-label="加粗选中文字" @click="mark('strong')"><strong>B</strong></button><button type="button" aria-label="斜体选中文字" @click="mark('em')"><em>I</em></button><button type="button" aria-label="行内代码" @click="mark('code')">代码</button><button type="button" @click="format('p')">正文</button><button type="button" @click="format('h2')">二级标题</button><button type="button" @click="format('h3')">三级标题</button><button type="button" @click="format('ul')">无序列表</button><button type="button" @click="format('ol')">有序列表</button></div><div ref="editor" class="rich-surface" role="textbox" :aria-label="label ?? '正文富文本'" aria-multiline="true" contenteditable="true" @input="update" @mouseup="remember" @keyup="remember" @paste="paste" @click="remember"></div><div class="link-row"><label class="sr-only" :for="linkId">链接地址</label><input :id="linkId" v-model="link" placeholder="选中文字后输入链接地址" aria-label="链接地址"><button type="button" @click="applyLink">添加链接</button></div><p v-if="issue" role="status" class="hint">{{ issue }}</p></div></template>
