// Real local API + MemoryStore + Miniflare R2. No production access or mocked maintenance responses.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const origin = 'http://127.0.0.1:5195';
const output = process.env.XVYIN_QA_OUTPUT ? resolve(process.env.XVYIN_QA_OUTPUT) : resolve(import.meta.dirname, '../../../../..', 'upgrade-maintenance-2026-09-29', 'admin-ui');
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), origin, boundary: 'Real application routes, authentication, CSRF, MemoryStore and Miniflare R2. Local controls only reset fixture data, inject read failures and move the test clock. Maintenance API responses are never intercepted. Seeded R2 rejects any mutation. No remote calls.', cases: [] };
const browser = await chromium.launch({ executablePath: process.env.XVYIN_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });

async function run(name, viewport, empty = false) {
  const entry = { name, viewport, empty, checks: [], pageErrors: [], consoleErrors: [], consoleWarnings: [], responses: [], screenshots: [] };
  report.cases.push(entry);
  const context = await browser.newContext({ viewport, locale: 'zh-CN', reducedMotion: 'reduce' });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const pending = [];
  page.on('pageerror', error => entry.pageErrors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error' && !/\b401\b|\b503\b/.test(message.text())) entry.consoleErrors.push(message.text()); if (message.type() === 'warning') entry.consoleWarnings.push(message.text()); });
  page.on('response', response => { if (response.url().includes('/api/v1/admin/maintenance/')) pending.push((async () => { const result = await response.json(); entry.responses.push({ method: response.request().method(), path: new URL(response.url()).pathname, status: response.status(), result }); })()); });
  const control = async (action, body) => { const response = await page.request.post(`${origin}/__fixture/${action}`, { headers: { 'x-local-ui-fixture': 'phase2-only' }, data: body }); assert.equal(response.ok(), true); return response.json(); };
  const diagnostics = async () => { const response = await page.request.get(`${origin}/__fixture/diagnostics`, { headers: { 'x-local-ui-fixture': 'phase2-only' } }); assert.equal(response.ok(), true); return response.json(); };
  const status = async part => { const response = await page.request.get(`${origin}/api/v1/admin/maintenance/${part}`); assert.equal(response.ok(), true); return (await response.json()).data; };
  const nav = async label => { if (viewport.width < 760) await page.getByRole('button', { name: '打开管理导航', exact: true }).click(); await page.locator('.sidebar nav button').filter({ hasText: new RegExp(`^.*${label}$`) }).click(); await page.locator('.page-heading h1').filter({ hasText: label }).waitFor(); };
  const screenshot = async suffix => { const file = `${name}-${suffix}.png`; await page.screenshot({ path: resolve(output, file) }); entry.screenshots.push(file); };
  const expiry = page.getByRole('region', { name: '到期记录维护', exact: true });
  const storage = page.getByRole('region', { name: 'R2 容量盘点', exact: true });
  const stopAfterFirstRequest = async (region, startButton, suffix, pauseLabel) => {
    const request = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname.endsWith(suffix));
    await region.getByRole('button', { name: startButton, exact: true }).click();
    await request;
    await region.getByRole('button', { name: pauseLabel, exact: true }).click();
  };
  try {
    await control('reset', { empty });
    await page.goto(origin + '/admin/');
    assert.match(await page.title(), /本地维护验证/);
    await page.getByLabel('管理员账号', { exact: true }).fill('ui-fixture'); await page.getByLabel('密码', { exact: true }).fill('test-only-not-a-real-account');
    await page.getByRole('button', { name: '登录管理后台', exact: true }).click();
    await page.locator('.page-heading h1').filter({ hasText: '总览' }).waitFor(); await nav('维护');
    await expiry.getByRole('button', { name: '开始维护', exact: true }).waitFor();
    await storage.getByRole('status').filter({ hasText: '还没有容量盘点' }).waitFor();
    await screenshot('initial');
    entry.checks.push('maintenance navigation and initial no-inventory state are reachable');
    if (!empty) {
      const singleResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/expiry/advance'));
      await expiry.getByRole('button', { name: '运行一步', exact: true }).click();
      const single = (await (await singleResponse).json()).data;
      await expiry.getByRole('button', { name: '继续维护', exact: true }).waitFor();
      assert.equal(single.budget.stepsUsed, 1);
      await page.waitForTimeout(600); assert.deepEqual(await status('expiry'), single);
      entry.checks.push('single-step control advances once without starting a background loop');
      await stopAfterFirstRequest(expiry, '继续维护', '/expiry/advance', '暂停维护');
      await expiry.getByRole('status').filter({ hasText: '已暂停本页连续维护' }).waitFor();
      const paused = await status('expiry'); assert.ok(paused.backfill.scanned > 0); assert.equal(paused.phase, 'backfill');
      await expiry.evaluate(element => element.scrollIntoView({ block: 'start' })); await screenshot('expiry-paused');
      await nav('总览'); await nav('维护');
      await expiry.getByRole('button', { name: '继续维护', exact: true }).waitFor();
      assert.deepEqual(await status('expiry'), paused);
      entry.checks.push('expiry pause completes only its current batch and checkpoint survives navigation');

      await control('fault', { target: 'expiry' }); await expiry.getByRole('button', { name: '继续维护', exact: true }).click();
      await expiry.getByRole('alert').filter({ hasText: '服务暂时不可用' }).waitFor();
      assert.equal((await status('expiry')).busy, true);
      await expiry.evaluate(element => element.scrollIntoView({ block: 'start' }));
      await screenshot('expiry-read-failure');
      await control('clock', { advanceMs: 121000 });
      await expiry.getByRole('button', { name: '刷新维护进度', exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('[aria-labelledby="expiry-maintenance-title"] button')].some(button => button.textContent === '继续维护' && !button.disabled));
      await expiry.getByRole('button', { name: '继续维护', exact: true }).click();
      await expiry.getByRole('status').filter({ hasText: '本轮检查已完成' }).waitFor({ timeout: 45000 });
      const complete = await status('expiry'), checked = await diagnostics();
      assert.equal(complete.phase, 'cleanup'); assert.equal(complete.canAdvance, false); assert.ok(complete.cleanup.lastCompletedAt); assert.ok(complete.cleanup.deleted >= checked.expiredFixtureTotal);
      assert.equal(checked.remainingExpiredFixture, 0); assert.equal(checked.retainedFixturePresent, checked.retainedFixtureTotal); assert.equal(checked.commentPreserved, true); assert.equal(complete.backfill.invalid, 3);
      entry.expiryCompleted = complete; entry.checks.push('real store read failure preserves checkpoint; retry after lease expiry removes expired fixtures while future, invalid and comment records remain');
      await screenshot('expiry-completed');
      await control('expiry-budget', {}); await expiry.getByRole('button', { name: '刷新维护进度', exact: true }).click();
      await expiry.getByRole('status').filter({ hasText: '今日维护预算已用完' }).waitFor();
      assert.equal(await expiry.getByRole('button', { name: '运行一步', exact: true }).isDisabled(), true);
      await expiry.locator('details > summary').click();
      const limited = await status('expiry'); assert.equal(limited.budget.stepsUsed, limited.budget.stepLimit);
      await screenshot('expiry-budget'); entry.checks.push('daily budget uses server limits, retains progress and disables further advance');

      await stopAfterFirstRequest(storage, '开始盘点', '/storage/advance', '暂停盘点');
      await storage.getByRole('status').filter({ hasText: '盘点已暂停' }).waitFor();
      const pausedStorage = await status('storage'); assert.equal(pausedStorage.job.status, 'paused'); assert.equal(pausedStorage.job.r2Pages, 1); assert.equal(pausedStorage.job.total.count, 100);
      await storage.evaluate(element => element.scrollIntoView({ block: 'start' })); await screenshot('storage-paused');
      await nav('总览'); await nav('维护'); await storage.getByRole('button', { name: '继续盘点', exact: true }).waitFor(); assert.deepEqual(await status('storage'), pausedStorage);
      await control('fault', { target: 'storage' }); await storage.getByRole('button', { name: '盘点一步', exact: true }).click();
      await storage.getByRole('alert').filter({ hasText: '本页读取未完成' }).waitFor();
      const failed = await status('storage'); assert.equal(failed.job.status, 'failed'); assert.equal(failed.job.total.count, 100); assert.equal(failed.job.lastError.retryable, true);
      await storage.evaluate(element => element.scrollIntoView({ block: 'start' }));
      await screenshot('storage-read-failure');
      await nav('总览'); await nav('维护'); await storage.getByRole('button', { name: '重试盘点', exact: true }).waitFor();
      await storage.getByRole('button', { name: '重试盘点', exact: true }).click();
      await storage.getByRole('status').filter({ hasText: '本次盘点已完成' }).waitFor({ timeout: 45000 });
      const inventoried = await status('storage'), storageChecked = await diagnostics();
      assert.deepEqual(inventoried.job.total, storageChecked.expectedStorage); assert.equal(inventoried.job.r2Pages, 2); assert.equal(inventoried.retention.objectScanComplete, true); assert.equal(inventoried.retention.metadataComplete, true);
      assert.equal(inventoried.retention.entries.length, 8); assert.ok(inventoried.retention.entries.some(entry => entry.disposition === 'review_only')); assert.ok(inventoried.retention.entries.some(entry => entry.releaseId === 'release-7' && entry.disposition === 'protect'));
      assert.equal(storageChecked.r2MutationsAttempted, 0); assert.equal(inventoried.retention.deleteAllowed, false);
      entry.inventoryCompleted = inventoried; entry.diagnostics = storageChecked;
      await storage.evaluate(element => element.scrollIntoView({ block: 'start' })); await screenshot('storage-completed');
      await storage.locator('.retention-entry summary').first().click(); await storage.getByRole('heading', { name: '历史发布保留建议' }).evaluate(element => element.scrollIntoView({ block: 'start' })); await screenshot('retention-advice');
      entry.checks.push('real Miniflare two-page inventory pauses, resumes, sanitizes a list failure and retries without duplicate counting or any R2 mutation');
      entry.checks.push('retention advice distinguishes protected recent/current releases and review-only history with no deletion action');
    } else {
      await expiry.getByRole('button', { name: '开始维护', exact: true }).click(); await expiry.getByRole('status').filter({ hasText: '本轮检查已完成' }).waitFor();
      assert.equal((await status('expiry')).cleanup.deleted, 0);
      await storage.getByRole('button', { name: '开始盘点', exact: true }).click(); await storage.getByRole('status').filter({ hasText: '本次盘点已完成' }).waitFor();
      await storage.getByText('本次盘点未发现存储文件，容量合计为 0 B。', { exact: true }).waitFor();
      const inventoried = await status('storage'); assert.deepEqual(inventoried.job.total, { count: 0, bytes: 0 }); assert.deepEqual(inventoried.retention.entries, []);
      await storage.evaluate(element => element.scrollIntoView({ block: 'start' })); await screenshot('completed-empty');
      entry.checks.push('empty real bucket completes with explicit 0 B and no release history; empty expiry cycle deletes nothing');
    }
    const body = await page.locator('body').innerText();
    assert.ok(!/qa-private-key-never-show|qa-private-payload-never-show|qa-token-never-show|phase2-test-identity-never-show|Firestore|projection/.test(body));
    assert.equal(await page.getByRole('button', { name: /永久删除|删除历史|清空存储/ }).count(), 0);
    assert.equal(await page.locator('vite-error-overlay, #__nuxt_error').count(), 0);
    entry.geometry = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth })); assert.ok(entry.geometry.scrollWidth <= entry.geometry.viewport);
    assert.deepEqual(entry.pageErrors, []); assert.deepEqual(entry.consoleErrors, []);
    await Promise.all(pending);
    assert.ok(!/qa-private-key-never-show|qa-private-payload-never-show|qa-token-never-show|phase2-test-identity-never-show/.test(JSON.stringify(entry.responses)));
    entry.checks.push('no private identifiers or object keys in maintenance responses/UI, no runtime errors or horizontal overflow');
    entry.passed = true;
  } catch (error) { entry.passed = false; entry.failure = String(error); await screenshot('failure').catch(() => {}); await writeFile(resolve(output, `${name}-failure.txt`), await page.locator('body').innerText()); }
  finally { await Promise.allSettled(pending); await context.close(); await writeFile(resolve(output, 'result.json'), JSON.stringify(report, null, 2)); }
}
try { await run('desktop', { width: 1440, height: 1050 }); await run('mobile', { width: 390, height: 844 }); await run('mobile-empty', { width: 390, height: 844 }, true); }
finally { await browser.close(); report.completedAt = new Date().toISOString(); report.passed = report.cases.length === 3 && report.cases.every(entry => entry.passed); await writeFile(resolve(output, 'result.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ passed: report.passed, output, cases: report.cases.map(entry => ({ name: entry.name, passed: entry.passed, failure: entry.failure })) }));
if (!report.passed) process.exitCode = 1;
