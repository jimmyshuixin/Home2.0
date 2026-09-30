import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import { RichTextDocumentSchema, type RichTextDocument } from '@xvyin/contracts'
import { compatibleExtensions, fromEditorDocument, semanticDocument, toEditorDocument } from '../src/richtext-compatibility'
import { plainTextParagraphs } from '../src/plain-text'

const p=(text='')=>({type:'paragraph' as const,content:text?[{type:'text' as const,text}]:[]})
const doc=(content:RichTextDocument['content']):RichTextDocument=>({type:'doc',content})
const roundTrip=(document:RichTextDocument)=>{const original=JSON.stringify(document);const restored=fromEditorDocument(toEditorDocument(document));expect(semanticDocument(restored)).toEqual(semanticDocument(document));expect(JSON.stringify(document)).toBe(original);return restored}

describe('production Tiptap contract boundary',()=>{
  it.each([doc([]),doc([p()]),doc([p('中文原文'),p(),p('后段')])])('preserves empty and plain documents without inserting trailing nodes',document=>{roundTrip(document)})
  it('preserves all heading levels, empty headings and mixed inline marks',()=>{
    const value=doc([1,2,3,4,5,6].map(level=>({type:'heading',attrs:{level},content:level===6?[]:[{type:'text',text:'标题'+level,marks:[{type:'bold'},{type:'italic'}]},{type:'hardBreak'},{type:'text',text:'续行'}]})))
    expect(roundTrip(value).content).toHaveLength(6)
  })
  it('retains simultaneous code/bold/italic/strike/link and link title instead of applying the default code exclusion',()=>{
    const value=doc([{type:'paragraph',content:[{type:'text',text:'同一文字',marks:[{type:'code'},{type:'bold'},{type:'italic'},{type:'strike'},{type:'link',attrs:{href:'https://example.com/a',title:'说明'}}]}]}])
    expect(JSON.stringify(roundTrip(value))).toContain('说明')
    expect((roundTrip(value).content[0] as any).content[0].marks).toHaveLength(5)
  })
  it('preserves ordered starts, multi-paragraph items and legal legacy nested-only list items',()=>{
    const value=doc([{type:'orderedList',attrs:{start:3},content:[{type:'listItem',content:[p('首段'),p('次段'),{type:'bulletList',content:[{type:'listItem',content:[p('更深')]}]}]},{type:'listItem',content:[{type:'bulletList',content:[{type:'listItem',content:[p('旧稿只含嵌套列表')]}]}]}]}])
    roundTrip(value)
  })
  it('normalizes only equivalent default starts, adjacent text and mark order',()=>{
    const value=doc([{type:'orderedList',attrs:{start:1},content:[{type:'listItem',content:[{type:'paragraph',content:[{type:'text',text:'前',marks:[{type:'italic'},{type:'bold'}]},{type:'text',text:'后',marks:[{type:'bold'},{type:'italic'}]}]}]}]}])
    roundTrip(value)
  })
  it('reuses the production multi-paragraph paste representation',()=>{
    const value=doc(plainTextParagraphs('甲\r\n乙\r\n\r\n丙\n丁'))
    expect(roundTrip(value)).toEqual(value)
  })
  it.each(['https://example.com/path?a=1','#block-one','/creations/example'])('preserves safe link %s',href=>{
    roundTrip(doc([{type:'paragraph',content:[{type:'text',text:'链接',marks:[{type:'link',attrs:{href}}]}]}]))
  })
  it.each(['javascript:alert(1)','data:text/html,test','http://example.com','//evil.invalid','https://user:pass@example.com/','/%2f/evil.invalid'])('rejects unsafe link %s at both directions',href=>{
    const value=doc([{type:'paragraph',content:[{type:'text',text:'链接',marks:[{type:'link',attrs:{href}}]}]}])
    expect(()=>toEditorDocument(value)).toThrow();expect(()=>fromEditorDocument(value)).toThrow()
  })
  it.each(['blockquote','codeBlock','horizontalRule','image','iframe'])('rejects unsupported node %s without stripping it',type=>{
    expect(()=>fromEditorDocument({type:'doc',content:[{type,content:[p('不能悄悄丢弃')]}]})).toThrow()
  })
  it.each(['underline','textStyle','highlight'])('rejects unsupported mark %s',type=>{
    expect(()=>fromEditorDocument(doc([{type:'paragraph',content:[{type:'text',text:'保留原文',marks:[{type} as any]}]}]))).toThrow()
  })
  it('preserves duplicate legacy marks instead of silently merging them',()=>{
    const value=doc([{type:'paragraph',content:[{type:'text',text:'旧稿',marks:[{type:'bold'},{type:'bold'}]}]}])
    expect(RichTextDocumentSchema.safeParse(value).success).toBe(true)
    expect(fromEditorDocument(toEditorDocument(value))).toEqual(value)
  })
  it('preserves duplicate links with distinct titles and other marks while unrelated text changes',()=>{
    const value=doc([{type:'paragraph',content:[{type:'text',text:'旧稿',marks:[{type:'link',attrs:{href:'/creations/one',title:'第一条'}},{type:'link',attrs:{href:'/creations/two',title:'第二条'}},{type:'code'}]},{type:'text',text:'后段'}]}])
    const encoded=toEditorDocument(value);encoded.content![0]!.content![1]!.text='已修改后段';const restored=fromEditorDocument(encoded);
    expect((restored.content[0] as any).content[0]).toEqual((value.content[0] as any).content[0]);expect((restored.content[0] as any).content[1].text).toBe('已修改后段');
  })
  it('refuses non-default unrepresentable list attributes, unknown attributes and headings in list items',()=>{
    expect(()=>fromEditorDocument({type:'doc',content:[{type:'orderedList',attrs:{start:1,type:'A'},content:[{type:'listItem',content:[p('A')]}]}]})).toThrow()
    expect(()=>fromEditorDocument({type:'doc',content:[{type:'paragraph',attrs:{style:'color:red'},content:[]}]})).toThrow()
    expect(()=>fromEditorDocument({type:'doc',content:[{type:'bulletList',content:[{type:'listItem',content:[{type:'heading',attrs:{level:2},content:[]}]}]}]})).toThrow()
  })
  it('applies existing content limits and does not recurse into cyclic or unbounded values',()=>{
    expect(()=>toEditorDocument(doc([p('字'.repeat(32001))]))).toThrow()
    expect(()=>fromEditorDocument(doc(Array.from({length:1001},()=>p())))).toThrow()
    const cycle:any={type:'doc',content:[]};cycle.content.push(cycle)
    expect(()=>fromEditorDocument(cycle)).toThrow()
    expect(()=>toEditorDocument(doc([p('<script>alert(1)</script>')]))).toThrow()
  })
  it('contains exactly the existing document node and mark names',()=>{
    const schema=getSchema(compatibleExtensions())
    expect(Object.keys(schema.nodes).sort()).toEqual(['bulletList','doc','hardBreak','heading','listItem','orderedList','paragraph','text'].sort())
    expect(Object.keys(schema.marks).sort()).toEqual(['bold','code','italic','link','strike','legacyMarks'].sort())
  })
})
