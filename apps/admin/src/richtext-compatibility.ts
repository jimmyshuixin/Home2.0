import { Mark, Node as EditorNode, getSchema, type JSONContent } from '@tiptap/core'
import type { DOMOutputSpec } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import { boundedTreeProblem, RichTextDocumentSchema, SafeHrefSchema, type RichTextDocument } from '@xvyin/contracts'

export class CompatibilityError extends Error { constructor(message = '此内容不能无损转换，已保留原文。') { super(message); this.name = 'CompatibilityError' } }
const object = (value: unknown): Record<string, any> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CompatibilityError(); return value as Record<string, any> }
function keys(value: Record<string, any>, allowed: string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) throw new CompatibilityError() }
function attrs(value: unknown, allowed: string[]) { const data = value == null ? {} : object(value); keys(data, allowed); return data }

// The editor does not broaden the server schema. It supplies only missing
// compatibility behavior, notably code+other marks and legacy nested-only items.
const Document = EditorNode.create({ name: 'doc', topNode: true, content: '(paragraph|heading|bulletList|orderedList)*' })
const ListItem = EditorNode.create({ name: 'listItem', content: '(paragraph|bulletList|orderedList)+', defining: true, parseHTML: () => [{ tag: 'li' }], renderHTML: () => ['li', 0], addKeyboardShortcuts() { return { Enter: () => this.editor.commands.splitListItem(this.name), Tab: () => this.editor.commands.sinkListItem(this.name), 'Shift-Tab': () => this.editor.commands.liftListItem(this.name) } } })
const Code = Mark.create({ name: 'code', code: true, excludes: '', parseHTML: () => [{ tag: 'code' }], renderHTML: () => ['code', 0] })
const Link = Mark.create({
  name: 'link', inclusive: false,
  addAttributes: () => ({ href: { default: null }, title: { default: null } }),
  parseHTML: () => [{ tag: 'a[href]', getAttrs: element => SafeHrefSchema.safeParse((element as HTMLElement).getAttribute('href')).success ? null : false }],
  renderHTML: ({ HTMLAttributes }) => {
    const href = SafeHrefSchema.safeParse(HTMLAttributes.href)
    return href.success ? ['a', { href: href.data, ...(HTMLAttributes.title ? { title: HTMLAttributes.title } : {}), rel: 'noopener noreferrer' }, 0] : ['span', 0]
  },
})
// Some old documents legally contain duplicate marks, including links with
// distinct titles. ProseMirror normally collapses these. Keep those exact mark
// arrays in one internal mark; never expose this representation to the API.
const LegacyMarks = Mark.create({ name: 'legacyMarks', excludes: '', inclusive: false,
  addAttributes: () => ({ original: { default: [] } }),
  parseHTML: () => [],
  renderHTML: ({ mark }) => {
    let result: DOMOutputSpec = ['span', 0]
    for (const item of mark.attrs.original) {
      if (item.type === 'link') result = ['a', { href: SafeHrefSchema.parse(item.attrs.href), ...(item.attrs.title ? { title: item.attrs.title } : {}), rel: 'noopener noreferrer' }, result]
      else result = [({ bold: 'strong', italic: 'em', strike: 's', code: 'code' } as Record<string,string>)[item.type]!, result]
    }
    return result
  },
})
export const compatibleExtensions = () => [StarterKit.configure({
  document: false, listItem: false, code: false, link: false,
  blockquote: false, codeBlock: false, horizontalRule: false, underline: false, trailingNode: false,
}), Document, ListItem, Code, Link, LegacyMarks]

export function fromEditorDocument(input: unknown): RichTextDocument {
  if (boundedTreeProblem(input)) throw new CompatibilityError('内容超出结构限制。')
  const mark = (input: unknown) => {
    const node = object(input); keys(node, ['type', 'attrs'])
    if (node.type === 'link') { const a = attrs(node.attrs, ['href', 'title']); return { type: 'link', attrs: { href: a.href, ...(a.title != null ? { title: a.title } : {}) } } }
    if (!['bold', 'italic', 'strike', 'code'].includes(node.type)) throw new CompatibilityError()
    attrs(node.attrs, []); return { type: node.type }
  }
  const visit = (input: unknown): any => {
    const node = object(input); keys(node, ['type', 'attrs', 'content', 'text', 'marks'])
    if (node.type === 'text') { attrs(node.attrs, []); if (node.content !== undefined) throw new CompatibilityError(); const marks = node.marks?.flatMap((value: any) => { if (value.type !== 'legacyMarks') return [mark(value)]; keys(value, ['type','attrs']); const a = attrs(value.attrs, ['original']); if (!Array.isArray(a.original)) throw new CompatibilityError(); return a.original.map(mark) }); return { type: 'text', text: node.text, ...(marks?.length ? { marks } : {}) } }
    if (node.text !== undefined || node.marks?.length) throw new CompatibilityError()
    if (node.type === 'hardBreak') { attrs(node.attrs, []); if (node.content !== undefined) throw new CompatibilityError(); return { type: 'hardBreak' } }
    if (!['doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem'].includes(node.type)) throw new CompatibilityError()
    const children = node.content === undefined ? [] : Array.isArray(node.content) ? node.content.map(visit) : (() => { throw new CompatibilityError() })()
    if (node.type === 'heading') { const a = attrs(node.attrs, ['level']); return { type: 'heading', attrs: { level: a.level }, content: children } }
    if (node.type === 'orderedList') {
      const a = attrs(node.attrs, ['start', 'type']); if (a.type != null) throw new CompatibilityError('字母或罗马数字列表不属于现有内容格式。')
      return { type: 'orderedList', ...(a.start !== undefined && a.start !== 1 ? { attrs: { start: a.start } } : {}), content: children }
    }
    attrs(node.attrs, []); return { type: node.type, content: children }
  }
  return RichTextDocumentSchema.parse(visit(input))
}

/** Only semantic defaults and mark ordering are canonicalized; text/breaks/titles remain exact. */
export function semanticDocument(input: RichTextDocument): unknown {
  const visit = (node: any): any => {
    const result = structuredClone(node)
    if (result.type === 'orderedList' && (!result.attrs || result.attrs.start === 1)) delete result.attrs
    if (result.marks) { result.marks.sort((a: any, b: any) => a.type.localeCompare(b.type)); if (!result.marks.length) delete result.marks }
    if (result.content) {
      const content: any[] = []
      for (const child of result.content.map(visit)) {
        const previous = content.at(-1)
        if (previous?.type === 'text' && child.type === 'text' && JSON.stringify(previous.marks) === JSON.stringify(child.marks)) previous.text += child.text
        else content.push(child)
      }
      result.content = content
    }
    return result
  }
  return visit(RichTextDocumentSchema.parse(input))
}

export function toEditorDocument(input: unknown): JSONContent {
  const parsed = RichTextDocumentSchema.parse(input)
  const encode = (value: any): any => ({ ...value, ...(value.content ? { content: value.content.map(encode) } : {}), ...(value.marks && new Set(value.marks.map((item: any) => item.type)).size !== value.marks.length ? { marks: [{ type: 'legacyMarks', attrs: { original: value.marks } }] } : {}) })
  const schema = getSchema(compatibleExtensions()), node = schema.nodeFromJSON(encode(parsed))
  node.check()
  const restored = fromEditorDocument(node.toJSON())
  if (JSON.stringify(semanticDocument(restored)) !== JSON.stringify(semanticDocument(parsed))) throw new CompatibilityError()
  return node.toJSON()
}
