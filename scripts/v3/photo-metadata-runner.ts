import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { z } from 'zod';
import { IdSchema, ImageMimeSchema, MEDIA_LIMITS, PhotographyMetadataSchema, Sha256Schema } from '@xvyin/contracts';
import { extractPhotographyMetadata } from './photo-metadata';
import { createRunnerTransport, PublishError, readCredentials, validateOrigin } from './publish';

const PREFIX = '/api/v1/internal/photography';
const ItemSchema = z.object({ id: IdSchema, bytes: z.number().int().positive().max(MEDIA_LIMITS.imageBytes), mime: ImageMimeSchema, sha256: Sha256Schema, sourceUrl: z.string().max(512) }).strict();
const PageSchema = z.object({ items: z.array(ItemSchema).max(20), nextCursor: z.string().min(1).max(8192).nullable().optional(), scanned: z.number().int().min(0).max(20) }).strict();
const CompleteSchema = z.object({ status: z.enum(['updated', 'no_exif', 'already_done']) }).strict();
type Item = z.infer<typeof ItemSchema>;
export interface PhotographyRunnerClient { request(path: string, init?: RequestInit): Promise<Response> }
export interface PhotographyResult { assetId: string; status: 'updated' | 'no_exif' | 'already_done' | 'failed'; code?: string }
export interface PhotographyReport {
  version: 1; status: 'complete' | 'failed'; scanned: number; attempted: number;
  updated: number; no_exif: number; already_done: number; skipped: number; failed: number;
  results: PhotographyResult[]; errorCode?: string;
}
export class PhotographyRunnerError extends Error {
  constructor(readonly code: string) { super('摄影信息回填未完成；请核对私密汇总报告后重试。'); this.name = 'PhotographyRunnerError'; }
}
function check(value: unknown, code: string): asserts value { if (!value) throw new PhotographyRunnerError(code); }
function within(parent: string, child: string): boolean { const rel = relative(parent, child); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
/** Only categories and IDs are logged; never expose provider messages, EXIF or filenames. */
export function photographyFailureCode(error: unknown): string {
  return (error instanceof PhotographyRunnerError || error instanceof PublishError) && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : 'PHOTOGRAPHY_RUNNER_FAILED';
}
async function responseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); check(reader, 'EMPTY_RESPONSE');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; check(size <= 64 * 1024, 'RESPONSE_TOO_LARGE'); chunks.push(part.value); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); }
  catch { throw new PhotographyRunnerError('INVALID_RESPONSE'); }
}
async function api(client: PhotographyRunnerClient, path: string, init?: RequestInit): Promise<unknown> {
  // The shared transport handles retryable HTTP/network failures and refreshes OIDC.
  const response = await client.request(path, init), body = await responseJson(response);
  if (!response.ok) {
    const parsed = z.object({ error: z.object({ code: z.string().regex(/^[A-Z0-9_]{1,80}$/u) }) }).safeParse(body);
    throw new PhotographyRunnerError(parsed.success ? parsed.data.error.code : 'API_REQUEST_FAILED');
  }
  return z.object({ data: z.unknown() }).parse(body).data;
}
async function downloadSource(client: PhotographyRunnerClient, item: Item, path: string): Promise<void> {
  check(item.sourceUrl === `${PREFIX}/${item.id}/source`, 'SOURCE_URL_REJECTED');
  const response = await client.request(item.sourceUrl);
  if (!response.ok) { await response.body?.cancel(); throw new PhotographyRunnerError(`SOURCE_HTTP_${response.status}`); }
  if (response.status !== 200) { await response.body?.cancel(); throw new PhotographyRunnerError('SOURCE_PARTIAL_RESPONSE'); }
  const reader = response.body?.getReader(); check(reader, 'EMPTY_SOURCE');
  let sink: Awaited<ReturnType<typeof open>> | undefined;
  const hash = createHash('sha256'); let size = 0;
  try {
    sink = await open(path, 'wx', 0o600);
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; check(size <= item.bytes, 'SOURCE_SIZE_MISMATCH'); hash.update(part.value);
      let offset = 0;
      while (offset < part.value.byteLength) { const result = await sink.write(part.value, offset, part.value.byteLength - offset); check(result.bytesWritten > 0, 'SOURCE_WRITE_FAILED'); offset += result.bytesWritten; }
    }
    check(size === item.bytes, 'SOURCE_SIZE_MISMATCH');
    check(hash.digest('hex') === item.sha256, 'SOURCE_HASH_MISMATCH');
  } finally { await sink?.close(); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function extractSource(path: string, item: Item) {
  // metadata() reads headers without decoding/recompressing pixels. No output API
  // or variant upload route is used anywhere in this backfill runner.
  const details = await sharp(path, { limitInputPixels: MEDIA_LIMITS.imagePixels, failOn: 'error', sequentialRead: true }).timeout({ seconds: 120 }).metadata();
  const format = ({ 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' } as const)[item.mime];
  check(details.format === format, 'SOURCE_TYPE_MISMATCH');
  check(details.width && details.height && details.width * details.height <= MEDIA_LIMITS.imagePixels, 'SOURCE_PIXEL_LIMIT');
  const photography = extractPhotographyMetadata(details.exif);
  return photography ? PhotographyMetadataSchema.parse(photography) : null;
}
export interface PhotographyRunnerOptions {
  client: PhotographyRunnerClient; privateRoot?: string; maxScanned?: number;
  log?: (event: PhotographyResult | Omit<PhotographyReport, 'results'>) => void;
}
export async function runPhotographyBackfill(options: PhotographyRunnerOptions): Promise<PhotographyReport> {
  const maxScanned = options.maxScanned ?? 10_000;
  check(Number.isSafeInteger(maxScanned) && maxScanned >= 20 && maxScanned <= 10_000 && maxScanned % 20 === 0, 'INVALID_SCAN_LIMIT');
  // Avoid holding temporary originals open in libvips' file cache (especially
  // on Windows), and keep the serial header-only worker's memory bounded.
  sharp.cache({ memory: 16, files: 0, items: 20 }); sharp.concurrency(1);
  const privateRoot = resolve(options.privateRoot || '.private-build');
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  check((await lstat(privateRoot)).isDirectory() && !(await lstat(privateRoot)).isSymbolicLink(), 'INVALID_WORKSPACE');
  if (process.platform !== 'win32') await chmod(privateRoot, 0o700);
  const directory = await mkdtemp(resolve(privateRoot, 'photography-'));
  check(within(await realpath(privateRoot), await realpath(directory)), 'INVALID_WORKSPACE');
  const sourcePath = resolve(directory, 'source.upload'), reportPath = resolve(directory, 'report.json');
  check(within(directory, sourcePath) && within(directory, reportPath), 'INVALID_WORKSPACE');
  const report: PhotographyReport = { version: 1, status: 'complete', scanned: 0, attempted: 0, updated: 0, no_exif: 0, already_done: 0, skipped: 0, failed: 0, results: [] };
  let cursor: string | undefined; const seenCursors = new Set<string>(), seenIds = new Set<string>();
  const saveReport = () => writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  try {
    do {
      check(report.scanned < maxScanned, 'SCAN_LIMIT_REACHED');
      const path = cursor ? `${PREFIX}?${new URLSearchParams({ cursor })}` : PREFIX;
      const page = PageSchema.parse(await api(options.client, path));
      check(page.scanned >= page.items.length && report.scanned + page.scanned <= maxScanned && (!page.nextCursor || page.scanned > 0), 'INVALID_PAGE_PROGRESS');
      report.scanned += page.scanned;
      report.skipped += page.scanned - page.items.length;
      for (const item of page.items) {
        check(!seenIds.has(item.id), 'DUPLICATE_PAGE_ITEM'); seenIds.add(item.id); report.attempted++;
        let result: PhotographyResult;
        try {
          await downloadSource(options.client, item, sourcePath);
          const photography = await extractSource(sourcePath, item);
          const completed = CompleteSchema.parse(await api(options.client, `${PREFIX}/${item.id}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256: item.sha256, photography }) }));
          report[completed.status]++; result = { assetId: item.id, status: completed.status };
          if (completed.status === 'already_done') report.skipped++;
        } catch (error) {
          report.failed++; report.status = 'failed'; result = { assetId: item.id, status: 'failed', code: photographyFailureCode(error) };
        } finally {
          // This unique run owns exactly this temporary file. Do not delete any
          // original object, shared directory, variant, or another run's files.
          await rm(sourcePath, { force: true });
        }
        report.results.push(result); options.log?.(result); await saveReport();
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor) { check(!seenCursors.has(cursor), 'REPEATED_CURSOR'); seenCursors.add(cursor); }
      await saveReport();
    } while (cursor);
  } catch (error) { report.status = 'failed'; report.errorCode = photographyFailureCode(error); }
  finally { await saveReport(); const { results: _results, ...summary } = report; options.log?.(summary); }
  return report;
}
export async function photographyRunnerCli(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, options: { origin: { type: 'string' }, 'auth-file': { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) { process.stdout.write('读取原片 EXIF 并回填摄影信息（不会压缩或发布）：\nnode --import tsx scripts/v3/photo-metadata-runner.ts --origin https://xvyin.com [--auth-file <私密管理员会话JSON>]\nGitHub Actions 使用 OIDC；单次最多扫描 10000 条媒体记录。\n'); return; }
  check(values.origin, 'INVALID_ARGUMENTS'); const origin = validateOrigin(values.origin), mode = values['auth-file'] ? 'local' : 'github';
  check(mode === 'local' || process.env.GITHUB_ACTIONS === 'true' && /^\d+$/u.test(process.env.GITHUB_RUN_ID || ''), 'AUTH_REQUIRED');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const client = createRunnerTransport({ origin, mode, localRunId: randomUUID(), ...(values['auth-file'] ? { credentials: await readCredentials(resolve(values['auth-file'])) } : {}), requestTimeoutMs: 10 * 60 * 1000 });
  const report = await runPhotographyBackfill({ client, privateRoot: resolve(root, '.private-build'), log: event => process.stdout.write(`${JSON.stringify(event)}\n`) });
  if (report.status === 'failed') throw new PhotographyRunnerError('BACKFILL_INCOMPLETE');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) photographyRunnerCli().catch(error => { process.stderr.write(`${JSON.stringify({ code: photographyFailureCode(error), status: 'failed' })}\n`); process.exitCode = 1; });
