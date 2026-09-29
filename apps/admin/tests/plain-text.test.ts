import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { RichTextDocumentSchema } from '@xvyin/contracts';
import { plainTextParagraphs } from '../src/plain-text';
import DraftRichText from '../src/components/DraftRichText';

async function renderClipboard(text: string, list = false) {
  const paragraphs = plainTextParagraphs(text);
  const document = RichTextDocumentSchema.parse({ type: 'doc', content: list ? [{ type: 'bulletList', content: [{ type: 'listItem', content: paragraphs }] }] : paragraphs });
  return renderToString(createSSRApp({ render: () => h(DraftRichText, { document }) }));
}

describe('plain text clipboard content survives structured rendering', () => {
  it.each(['\n', '\r\n', '\r'])('preserves single line breaks and separate paragraphs for %j', async newline => {
    const html = await renderClipboard(['第一行', '第二行', '', '第二段'].join(newline));
    expect(html).toContain('<p>第一行<br>第二行</p><p>第二段</p>');
  });
  it('preserves blank-line separation inside a list item', async () => {
    const html = await renderClipboard('条目首行\n条目次行\n \t\n条目下一段', true);
    expect(html).toContain('<ul><li><p>条目首行<br>条目次行</p><p>条目下一段</p></li></ul>');
  });
  it('keeps pasted markup inert in preview and subject to existing document validation', async () => {
    const document = { type: 'doc' as const, content: plainTextParagraphs('<img src=x onerror=alert(1)>\n& hello') };
    expect(RichTextDocumentSchema.safeParse(document).success).toBe(false);
    const html = await renderToString(createSSRApp({ render: () => h(DraftRichText, { document }) }));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;<br>&amp; hello');
    expect(html).not.toContain('<img');
  });
  it('preserves leading and trailing single newlines without empty text nodes', async () => {
    const html = await renderClipboard('\n一句话\n');
    expect(html).toContain('<p><br>一句话<br></p>');
    expect(() => RichTextDocumentSchema.parse({ type: 'doc', content: plainTextParagraphs('') })).not.toThrow();
  });
});
