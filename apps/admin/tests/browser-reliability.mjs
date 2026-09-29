// Run against the isolated browser-fixture.ts only; no cloud accounts or writes.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const origin = 'http://127.0.0.1:5194';
const output = process.env.XVYIN_QA_OUTPUT ? resolve(process.env.XVYIN_QA_OUTPUT) : resolve(import.meta.dirname, '../../../../..', 'upgrade-reliability-2026-09-29', 'admin-regression');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.XVYIN_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [], warnings = [], checks = [];
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not complete; page: ${page.url()}`)), 20000); })]); }
  finally { clearTimeout(timer); }
}
let allowDiscard = true, confirmations = 0;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() === 'error' && !message.text().includes('401')) errors.push(message.text());
  if (message.type() === 'warning') warnings.push(message.text());
});
page.on('dialog', async dialog => { confirmations++; await (allowDiscard ? dialog.accept() : dialog.dismiss()); });
const nav = async label => {
  await page.locator('.sidebar nav button').filter({ hasText: label }).click();
  await page.locator('.page-heading h1').filter({ hasText: label }).waitFor();
};
const nextSave = () => {
  let release, ready, completed, captured = false;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { ready = resolve; });
  const finished = new Promise(resolve => { completed = resolve; });
  const handler = async route => {
    if (captured || !['POST', 'PATCH'].includes(route.request().method())) return route.fallback();
    captured = true;
    const response = await route.fetch();
    assert.equal(response.ok(), true);
    ready({ response: await response.json(), request: route.request().postDataJSON() });
    await gate;
    await route.fulfill({ response });
    await page.unroute('**/api/v1/admin/creations**', handler);
    completed();
  };
  return { install: () => page.route('**/api/v1/admin/creations**', handler), started, finished, release: () => release() };
};

try {
  await page.goto(origin + '/admin/');
  await page.getByRole('heading', { name: '欢迎回来' }).waitFor();
  assert.match(await page.title(), /本地 UI 验证/);
  await page.getByLabel('管理员账号', { exact: true }).fill('ui-fixture');
  await page.getByLabel('密码', { exact: true }).fill('test-only-not-a-real-account');
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await page.locator('.page-heading h1').filter({ hasText: '总览' }).waitFor();
  await nav('创作');
  await page.getByRole('button', { name: '＋ 新建创作', exact: true }).click();
  const title = '本地可靠性回归 ' + crypto.randomUUID().slice(0, 8);
  await page.getByLabel('创作标题', { exact: true }).fill(title);
  await page.getByPlaceholder('my-creation', { exact: true }).fill('reliability-' + crypto.randomUUID().slice(0, 8));
  await page.getByRole('button', { name: '＋ 富文本', exact: true }).click();
  const surface = page.getByRole('textbox', { name: '第1块富文本' });
  await surface.click(); await page.keyboard.insertText('前后');
  await surface.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && !node.textContent.includes('前后')) {}
    if (!node) throw new Error('The typed text is missing');
    const range = document.createRange(); range.setStart(node, 1); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const data = new DataTransfer(); data.setData('text/plain', '第一行\r\n第二行\r\n\r\n第二段');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const held = nextSave(); await held.install();
  await page.getByRole('button', { name: '保存并准备发布', exact: true }).click();
  const saved = await bounded(held.started, 'First save request');
  const content = saved.request.draft.blocks[0].document.content;
  assert.equal(content.length, 2);
  assert.equal(content[0].type, 'paragraph'); assert.equal(content[1].type, 'paragraph');
  assert.equal(content[0].content.filter(node => node.type === 'text').map(node => node.text).join(''), '前第一行第二行');
  assert.equal(content[0].content.some(node => node.type === 'hardBreak'), true);
  assert.equal(content[1].content.filter(node => node.type === 'text').map(node => node.text).join(''), '第二段后');
  checks.push('CRLF paste preserves prefix, suffix, hard break and separate paragraphs in the saved structured document');

  await nav('摄影');
  await page.getByRole('button', { name: '＋ 新建摄影', exact: true }).click();
  held.release(); await held.finished;
  await page.getByLabel('摄影系列标题', { exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.editor-fieldset')?.disabled);
  assert.match(page.url(), /\/admin\/albums\/new$/);
  assert.equal(await page.locator('.release-center').count(), 0);
  assert.equal(await page.locator('.notice.success').count(), 0);
  checks.push('a late creation save does not redirect a new album or open its release panel');

  await nav('创作');
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.getByLabel('摘要', { exact: true }).fill('第二次保存留在原栏目，响应延迟用于验证设置草稿保护。');
  const second = nextSave(); await second.install();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await bounded(second.started, 'Second save request');
  await nav('设置');
  await page.getByLabel('首页简介', { exact: true }).fill('当前设置页尚未保存的编辑');
  second.release(); await second.finished;
  await page.waitForFunction(() => document.querySelector('.unsaved-dot')?.textContent === '未保存');
  assert.equal(await page.getByLabel('首页简介', { exact: true }).inputValue(), '当前设置页尚未保存的编辑');
  checks.push('a late creation save preserves another settings page dirty state');

  // Supply an existing avatar in an isolated response so clearing it is the
  // only settings edit; no media upload or external asset is needed.
  await page.route('**/api/v1/admin/settings/site', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch(); const body = await response.json();
    body.data.draft.avatarAssetId = 'avatar-reliability-fixture';
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/v1/admin/media/avatar-reliability-fixture', route => route.fulfill({ json: {
    data: { id: 'avatar-reliability-fixture', kind: 'image', originalBytes: 1, status: 'ready', variants: [] },
    meta: { requestId: 'local-ui', schemaVersion: 1 },
  } }));
  await nav('总览'); await nav('设置');
  await page.getByRole('button', { name: '清除', exact: true }).click();
  await page.locator('.unsaved-dot').waitFor();
  const previousConfirmations = confirmations;
  allowDiscard = false;
  await page.locator('.sidebar nav button').filter({ hasText: '总览' }).click();
  assert.equal(confirmations, previousConfirmations + 1);
  assert.match(page.url(), /\/admin\/settings$/);
  checks.push('clearing only the avatar marks settings dirty and cancelling discard preserves the page');
  await page.screenshot({ path: resolve(output, 'settings-dirty-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: resolve(output, 'settings-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1050 });
  allowDiscard = true;

  await nav('媒体');
  let duplicateAttempts = 0, firstRequested, releaseFirst;
  const requested = new Promise(resolve => { firstRequested = resolve; });
  const interrupted = new Promise(resolve => { releaseFirst = resolve; });
  const duplicateHandler = async route => {
    duplicateAttempts++;
    if (duplicateAttempts === 1) { firstRequested(); await interrupted; await route.abort('aborted').catch(() => {}); return; }
    await route.fulfill({ json: {
      data: { id: 'pause-reliability-fixture', originalName: 'local-pause.jpg', kind: 'image', originalBytes: 5, status: 'ready', variants: [] },
      meta: { requestId: 'local-ui', schemaVersion: 1 },
    } });
  };
  await page.route('**/api/v1/admin/media/duplicates?**', duplicateHandler);
  await page.locator('.media-upload input[type=file]').setInputFiles({ name: 'local-pause.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('photo') });
  await bounded(requested, 'Upload duplicate lookup');
  await page.getByRole('button', { name: '暂停队列', exact: true }).click();
  await page.locator('.upload-row').getByText('已暂停', { exact: true }).waitFor();
  await page.getByRole('button', { name: '继续队列', exact: true }).click();
  await page.locator('.upload-row').getByText('可用于内容', { exact: true }).waitFor();
  assert.equal(duplicateAttempts, 2);
  releaseFirst();
  await page.unroute('**/api/v1/admin/media/duplicates?**', duplicateHandler);
  checks.push('real browser hash worker upload pauses and global continue resumes the same file');
  await page.screenshot({ path: resolve(output, 'upload-resumed-desktop.png') });

  await nav('创作');
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.getByRole('button', { name: '＋ 富文本', exact: true }).click();
  const listEditor = page.locator('.rich-editor').last();
  await listEditor.getByRole('textbox', { name: '第2块富文本' }).click();
  await page.keyboard.insertText('列表前后');
  await listEditor.getByRole('button', { name: '无序列表', exact: true }).click();
  await listEditor.getByRole('textbox', { name: '第2块富文本' }).evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && !node.textContent.includes('列表前后')) {}
    if (!node) throw new Error('List text is missing');
    const range = document.createRange(); range.setStart(node, 3); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const data = new DataTransfer(); data.setData('text/plain', '第一段\n\n第二段');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  assert.equal(await listEditor.locator('ul > li > p').count(), 2);
  const listSave = page.waitForResponse(response => response.url().includes('/api/v1/admin/creations/') && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  const listResult = await (await listSave).json();
  const list = listResult.data.draft.blocks[1].document.content[0];
  assert.equal(list.type, 'bulletList'); assert.equal(list.content[0].content.length, 2);
  assert.equal(list.content[0].content[0].content.filter(node => node.type === 'text').map(node => node.text).join(''), '列表前第一段');
  assert.equal(list.content[0].content[1].content.filter(node => node.type === 'text').map(node => node.text).join(''), '第二段后');
  await page.getByRole('button', { name: '预览内容', exact: true }).click();
  await page.getByRole('dialog').locator('.draft-richtext').last().waitFor();
  assert.equal(await page.getByRole('dialog').locator('.draft-richtext ul > li > p').count(), 2);
  checks.push('list-item paste retains both paragraphs and surrounding text through API save and rendered draft preview');
  await page.screenshot({ path: resolve(output, 'paste-preview-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: resolve(output, 'paste-preview-mobile.png') });
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ passed: true, origin, viewports: ['1440x1050', '390x844'], scope: 'isolated local real app and API; delayed save responses, fixture avatar and duplicate upload responses; no remote storage or publishing', checks, errors, warnings }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, output }));
} catch (error) {
  await page.screenshot({ path: resolve(output, 'failure.png') });
  await writeFile(resolve(output, 'failure.txt'), await page.locator('body').innerText());
  console.error(error); console.error(JSON.stringify({ errors, checks })); process.exitCode = 1;
} finally { await browser.close(); }
