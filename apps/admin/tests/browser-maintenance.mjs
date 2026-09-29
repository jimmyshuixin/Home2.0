// Local-only UI review. Comment indexing uses browser-fixture's real MemoryStore;
// media lifecycle responses are synthetic, so this test cannot delete stored media.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const origin = 'http://127.0.0.1:5194';
const output = process.env.XVYIN_QA_OUTPUT ? resolve(process.env.XVYIN_QA_OUTPUT) : resolve(import.meta.dirname, '../../../../..', 'upgrade-reliability-2026-09-29', 'maintenance-ui');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.XVYIN_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [], warnings = [], checks = [], mediaRequests = [];
let catalogWrites = 0;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() === 'error' && !/401|503/.test(message.text())) errors.push(message.text());
  if (message.type() === 'warning') warnings.push(message.text());
});
page.on('request', request => { if (request.url().endsWith('/admin/comments/catalog/advance')) catalogWrites++; });
const nav = async label => {
  await page.locator('.sidebar nav button').filter({ hasText: label }).click();
  await page.locator('.page-heading h1').filter({ hasText: label }).waitFor();
};
const meta = { requestId: 'local-maintenance-ui', schemaVersion: 1 };
const respond = (route, data, extraMeta = {}) => route.fulfill({ json: { data, meta: { ...meta, ...extraMeta } } });
let catalogBefore, catalogAfter;

try {
  await page.goto(origin + '/admin/');
  await page.getByRole('heading', { name: '欢迎回来' }).waitFor();
  assert.match(await page.title(), /本地 UI 验证/);
  await page.getByLabel('管理员账号', { exact: true }).fill('ui-fixture');
  await page.getByLabel('密码', { exact: true }).fill('test-only-not-a-real-account');
  await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
  await page.locator('.page-heading h1').filter({ hasText: '总览' }).waitFor();
  await nav('评论审核');
  const catalogPanel = page.getByRole('region', { name: '留言索引更新' });
  await catalogPanel.waitFor();
  catalogBefore = await (await page.request.get(origin + '/api/v1/admin/comments/catalog')).json();
  assert.equal(typeof catalogBefore.data.ready, 'boolean');
  if (!catalogBefore.data.ready) {
    await catalogPanel.getByRole('button', { name: '更新留言索引', exact: true }).click();
    await catalogPanel.getByRole('status').filter({ hasText: '留言已按目标与时间整理' }).waitFor();
    assert.equal(catalogWrites, 1);
    checks.push('empty real comment catalog becomes ready with one visible update action and one API advance');
  } else {
    checks.push('existing ready real comment catalog is displayed correctly (repeat run)');
  }
  catalogAfter = await (await page.request.get(origin + '/api/v1/admin/comments/catalog')).json();
  assert.equal(catalogAfter.data.ready, true); assert.equal(catalogAfter.data.cursor, null);
  await page.screenshot({ path: resolve(output, 'comment-index-ready-desktop.png') });
  await nav('总览'); await nav('评论审核');
  await catalogPanel.getByRole('status').filter({ hasText: '留言已按目标与时间整理' }).waitFor();
  await catalogPanel.getByRole('button', { name: '刷新进度', exact: true }).click();
  const restored = await (await page.request.get(origin + '/api/v1/admin/comments/catalog')).json();
  assert.deepEqual(restored.data, catalogAfter.data);
  checks.push('comment catalog checkpoint remains ready and unchanged after leaving, returning and refreshing');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve(output, 'comment-index-ready-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1050 });

  const asset = { id: 'failed-maintenance-fixture', originalName: 'local-failed-photo.jpg', kind: 'image', originalBytes: 2000000, totalBytes: 2000000, status: 'failed', processingStatus: 'failed', version: 1, lifecycle: 'active', variants: [], createdAt: '2026-09-29T10:00:00Z', error: { code: 'LOCAL_FIXTURE', message: '本地测试：模拟媒体处理失败' } };
  const job = { id: '11111111-2222-4333-8444-555555555555', assetId: asset.id, status: 'checking', processed: 0, references: [], totalKeys: 2, completedKeys: 0, bytes: 2000000, reservedBytes: 3000000, recovery: true, totalUploads: 1, abortedUploads: 0 };
  let interruptedOnce = false, resumed = false;
  await page.route('**/api/v1/admin/media**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/v1/admin/media/catalog') return respond(route, { ready: true, processed: 1 });
    if (url.pathname === '/api/v1/admin/media') {
      const lifecycle = url.searchParams.get('lifecycle') || 'active';
      const shown = asset.lifecycle !== 'deleted' && (lifecycle === asset.lifecycle || lifecycle === 'trash' && asset.lifecycle === 'purging');
      return respond(route, shown ? [{ ...asset }] : [], { quota: { usedBytes: asset.lifecycle === 'deleted' ? 0 : 2000000, reservedBytes: asset.lifecycle === 'deleted' ? 0 : 3000000, limitBytes: 9000000000 } });
    }
    if (!url.pathname.includes(asset.id) && !url.pathname.includes(job.id)) return route.fallback();
    mediaRequests.push({ method: request.method(), path: url.pathname });
    if (url.pathname.endsWith('/trash')) {
      assert.equal(request.postDataJSON().expectedVersion, 1);
      asset.lifecycle = 'trash'; asset.version = 2; return respond(route, { ...asset });
    }
    if (url.pathname.endsWith('/purge-check')) {
      assert.equal(request.postDataJSON().expectedVersion, 2);
      return respond(route, { ...job });
    }
    if (url.pathname.endsWith('/confirm')) {
      job.status = 'deleting'; asset.lifecycle = 'purging'; asset.purgeJobId = job.id;
      return respond(route, { ...job });
    }
    if (url.pathname.endsWith('/advance')) {
      if (job.status === 'checking') { job.status = 'ready'; job.processed = 12; return respond(route, { ...job }); }
      if (!interruptedOnce) {
        interruptedOnce = true;
        return route.fulfill({ status: 503, json: { error: { code: 'LOCAL_INTERRUPTION', message: '本地测试：模拟清理中断，任务进度已保留。' }, meta } });
      }
      assert.equal(resumed, true);
      job.status = 'deleted'; job.completedKeys = 2; job.abortedUploads = 1; asset.lifecycle = 'deleted';
      return respond(route, { ...job });
    }
    if (url.pathname.endsWith(job.id)) { resumed = true; return respond(route, { ...job }); }
    throw new Error('Unexpected media lifecycle request: ' + url.pathname);
  });
  await nav('媒体');
  await page.getByText('处理失败的文件可以先移入回收站', { exact: false }).waitFor();
  const card = page.locator('.media-card').filter({ hasText: asset.originalName });
  assert.equal(await card.getByRole('button', { name: '移入回收站', exact: true }).isEnabled(), true);
  await card.getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('dialog', { name: '移入回收站' }).getByRole('button', { name: '确认移入回收站', exact: true }).click();
  await page.getByRole('button', { name: '回收站', exact: true }).click();
  await card.getByRole('button', { name: '永久删除…', exact: true }).click();
  const purgeDialog = page.getByRole('dialog', { name: '永久删除媒体' });
  await purgeDialog.getByText('引用检查通过', { exact: false }).waitFor();
  await purgeDialog.getByText('和 3.0 MB 处理预留', { exact: false }).waitFor();
  await purgeDialog.getByText('将停止旧处理任务', { exact: false }).waitFor();
  const confirm = purgeDialog.getByRole('button', { name: '确认清理失败文件', exact: true });
  assert.equal(await confirm.isDisabled(), true);
  await page.screenshot({ path: resolve(output, 'failed-media-check-ready.png') });
  await purgeDialog.getByRole('checkbox').check(); assert.equal(await confirm.isEnabled(), true);
  checks.push('failed media recovery hint leads through trash to reference check, capacity/reservation explanation and explicit agreement');
  await confirm.click();
  await purgeDialog.getByRole('alert').filter({ hasText: '模拟清理中断' }).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('xvyin-media-purge-job-v1')), job.id);
  await page.screenshot({ path: resolve(output, 'failed-media-interrupted.png') });
  await purgeDialog.getByRole('button', { name: '稍后继续', exact: true }).click();
  await nav('总览'); await nav('媒体');
  await page.getByRole('button', { name: '继续查看', exact: true }).click();
  await purgeDialog.getByRole('status').filter({ hasText: '已永久删除，释放 5.0 MB' }).waitFor();
  assert.equal(resumed, true);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('xvyin-media-purge-job-v1')), null);
  await page.screenshot({ path: resolve(output, 'failed-media-resumed-complete.png') });
  checks.push('synthetic interrupted purge checkpoint survives leaving and returning, resumes its job and clears only after completion');
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ passed: true, origin, viewports: ['1440x1050', '390x844'], scope: 'real empty comment index persisted in local MemoryStore; media UI uses fully synthetic intercepted lifecycle responses and deletes no real objects', checks, catalogBefore: catalogBefore.data, catalogAfter: catalogAfter.data, catalogWrites, mediaRequests, expectedConsoleStatus: 503, errors, warnings }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, output }));
} catch (error) {
  await page.screenshot({ path: resolve(output, 'failure.png') });
  await writeFile(resolve(output, 'failure.txt'), await page.locator('body').innerText());
  console.error(error); console.error(JSON.stringify({ checks, errors, warnings })); process.exitCode = 1;
} finally { await browser.close(); }
