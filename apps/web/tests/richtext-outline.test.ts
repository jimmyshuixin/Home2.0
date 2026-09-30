import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { RichTextDocumentSchema, SafeHrefSchema, type RichTextDocument, type RichHeading } from '@xvyin/contracts'
import { richTextOutline } from '../lib/richtext-outline'
import { renderRichText } from '../lib/richtext-render'

const heading = (level: number, text: string): RichHeading => ({ type: 'heading', attrs: { level }, content: text ? [{ type: 'text', text }] : [] })
const block = (id: string, content: RichTextDocument['content']) => ({ id, type: 'richtext', document: RichTextDocumentSchema.parse({ type: 'doc', content }) })
const safeUrl = (value?: string | null) => { const parsed = SafeHrefSchema.safeParse(value); return parsed.success ? parsed.data : undefined }
const rendered = (blocks: ReturnType<typeof block>[]) => renderToString(createSSRApp({ render: () => h('article', blocks.map(item => h('section', { id: `block-${item.id}` }, renderRichText(item.document, safeUrl, item.id)))) }))

describe('complete reading outline and public heading anchors', () => {
  it('includes every heading within each rich text block in document order, retaining repeated and empty headings', async () => {
    const blocks = [block('first', [heading(1, '序'), { type: 'paragraph', content: [{ type: 'text', text: '正文' }] }, heading(3, '重复标题'), heading(2, '重复标题'), heading(6, '')]), block('second', [heading(4, '重复标题')])]
    const toc = richTextOutline(blocks)
    expect(toc).toEqual([
      { id: 'heading-first-1', label: '序', level: 2 },
      { id: 'heading-first-3', label: '重复标题', level: 3 },
      { id: 'heading-first-4', label: '重复标题', level: 2 },
      { id: 'heading-first-5', label: '未命名标题', level: 6 },
      { id: 'heading-second-1', label: '重复标题', level: 4 },
    ])
    const html = await rendered(blocks)
    const headings = [...html.matchAll(/<h([2-6]) id="([^"]+)">/gu)].map(match => ({ level: Number(match[1]), id: match[2] }))
    expect(headings).toEqual(toc.map(({ id, level }) => ({ id, level })))
    expect(new Set([...html.matchAll(/ id="([^"]+)"/gu)].map(match => match[1])).size).toBe(toc.length + blocks.length)
    expect(html).not.toContain('<h1')
    expect(html).toContain('id="block-first"')
  })

  it('keeps all six legal heading levels aligned with the public renderer', async () => {
    const blocks = [block('levels', [1, 2, 3, 4, 5, 6].map(level => heading(level, `标题${level}`)))]
    const toc = richTextOutline(blocks), html = await rendered(blocks)
    expect(toc.map(item => item.level)).toEqual([2, 2, 3, 4, 5, 6])
    toc.forEach(item => expect(html).toContain(`<h${item.level} id="${item.id}">${item.label}</h${item.level}>`))
  })

  it('creates human-readable labels from marked text and hard breaks while rendering marks and breaks literally', async () => {
    const blocks = [block('marked', [{ type: 'heading', attrs: { level: 2 }, content: [
      { type: 'text', text: ' 中文 ', marks: [{ type: 'bold' }] }, { type: 'hardBreak' },
      { type: 'text', text: '链接 & 引号 "', marks: [{ type: 'link', attrs: { href: '/creations/sample', title: '站内链接' } }] },
    ] }])]
    expect(richTextOutline(blocks)[0]?.label).toBe('中文 链接 & 引号 "')
    const html = await rendered(blocks)
    expect(html).toContain('<strong> 中文 </strong><br>')
    expect(html).toContain('href="/creations/sample" title="站内链接" rel="noopener noreferrer"')
    expect(html).toContain('链接 &amp; 引号 &quot;')
  })

  it('does not derive anchors from text or unrelated blocks and does not mutate content', () => {
    const blocks = [block('alpha', [heading(2, '起初')]), block('alpha-1', [heading(2, '起初')])]
    const before = JSON.stringify(blocks), toc = richTextOutline(blocks)
    expect(richTextOutline([{ id: 'image', type: 'image' }, ...blocks])).toEqual(toc)
    expect(JSON.stringify(blocks)).toBe(before)
    blocks[0]!.document.content[0] = heading(2, '修订标题')
    expect(richTextOutline(blocks).map(item => item.id)).toEqual(toc.map(item => item.id))
  })

  it('keeps paragraphs and nested lists out of the outline and renders existing text structure', async () => {
    const document: RichTextDocument = { type: 'doc', content: [{ type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '首行' }, { type: 'hardBreak' }, { type: 'text', text: '次行', marks: [{ type: 'italic' }, { type: 'strike' }, { type: 'code' }] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '嵌套' }] }] }] },
    ] }] }] }
    expect(richTextOutline([block('list', document.content)])).toEqual([])
    const html = await rendered([block('list', document.content)])
    expect(html).toContain('<ol start="3"><li><p>首行<br><code><s><em>次行</em></s></code></p><ul><li><p>嵌套</p></li></ul></li></ol>')
    expect(richTextOutline([block('empty', [])])).toEqual([])
  })

  it('does not invent an anchor when rendering a document outside content blocks', async () => {
    const html = await renderToString(createSSRApp({ render: () => h('div', renderRichText(block('unused', [heading(2, '关于')]).document, safeUrl)) }))
    expect(html).toBe('<div><h2>关于</h2></div>')
  })
})
