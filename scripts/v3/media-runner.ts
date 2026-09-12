import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { DetectedMediaMetadataSchema, IdSchema, UploadMetadataSchema, type UploadMetadata } from '@xvyin/contracts';
import { hashFile, MediaProcessingError, processMedia, type ProcessedMedia } from './process-media';
import { ProcessingVariantSchema } from '../../workers/api/src/processing';
import { createRunnerTransport, readCredentials, validateOrigin } from './publish';

/** Authentication/refresh is supplied by the shared private-runner HTTP client. */
export interface MediaRunnerClient { request(path: string, init?: RequestInit): Promise<Response> }
const TaskSchema = ProcessingVariantSchema.extend({ partSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(98), multipartEtag: z.string().regex(/^[a-f0-9]{32}-[1-9]\d?$/), partSize: z.literal(5 * 1024 * 1024), totalParts: z.number().int().positive().max(98), state: z.enum(['planned', 'uploading', 'completing', 'complete']), parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string(), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })) });
const StatusSchema = z.object({ assetId: IdSchema, runId: IdSchema, state: z.enum(['claimed', 'planned', 'ready', 'failed']), reservedBytes: z.number().int().nonnegative(), variants: z.array(TaskSchema) });
const ClaimSchema = StatusSchema.extend({ metadata: UploadMetadataSchema, sourceUrl: z.string() });
const LocalReportSchema = z.object({ metadata: DetectedMediaMetadataSchema, variants: z.array(ProcessingVariantSchema.extend({ path: z.string() }).strict()).min(1).max(7) }).strict();
type Status = z.infer<typeof StatusSchema>;
export class MediaRunnerError extends Error { constructor(readonly code: string, message: string, readonly status = 0) { super(message); this.name = 'MediaRunnerError'; } }
function requireValue(value: unknown, code: string, message: string): asserts value { if (!value) throw new MediaRunnerError(code, message); }
function isWithin(parent: string, child: string): boolean { const rel = relative(parent, child); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
const pause = (ms: number) => new Promise<void>(resolvePromise => setTimeout(resolvePromise, ms));
async function jsonBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); requireValue(reader, 'INVALID_RESPONSE', '处理服务返回空响应');
  let total = 0, content = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
  try { for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; requireValue(total <= 2 * 1024 * 1024, 'INVALID_RESPONSE', '处理服务响应过大'); content += decoder.decode(next.value, { stream: true }); } content += decoder.decode(); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(content);
}
function errorFrom(response: Response, body: unknown): MediaRunnerError {
  const parsed = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).safeParse(body);
  return new MediaRunnerError(parsed.success ? parsed.data.error.code : 'API_REQUEST_FAILED', parsed.success ? parsed.data.error.message : `处理服务返回 HTTP ${response.status}`, response.status);
}
async function api(client: MediaRunnerClient, path: string, init: RequestInit = {}, attempts = 4): Promise<unknown> {
  let previous: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await client.request(path, init), body = await jsonBody(response);
      if (!response.ok) throw errorFrom(response, body);
      return z.object({ data: z.unknown() }).parse(body).data;
    } catch (error) {
      previous = error;
      if (error instanceof MediaRunnerError && error.status > 0 && error.status < 500 && ![408, 429].includes(error.status)) throw error;
      if (attempt + 1 < attempts) await pause(Math.min(8000, 500 * 2 ** attempt));
    }
  }
  throw previous;
}
const jsonRequest = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function streamSource(client: MediaRunnerClient, path: string, output: string, declared: UploadMetadata): Promise<void> {
  const partial = `${output}.partial`; await rm(partial, { force: true });
  const response = await client.request(path);
  if (!response.ok) throw errorFrom(response, await jsonBody(response));
  requireValue(response.body, 'EMPTY_SOURCE', '原文件响应为空');
  const reader = response.body.getReader(), sink = await open(partial, 'wx', 0o600);
  let size = 0;
  // Every file write is awaited for backpressure and never accumulates a video.
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; requireValue(size <= declared.expectedBytes, 'SOURCE_SIZE_MISMATCH', '原文件超过上传声明大小'); let offset = 0; while (offset < next.value.byteLength) { const { bytesWritten } = await sink.write(next.value, offset, next.value.byteLength - offset); requireValue(bytesWritten > 0, 'SOURCE_WRITE_FAILED', '无法写入私密源文件'); offset += bytesWritten; } }
    await sink.close();
    requireValue(size === declared.expectedBytes, 'SOURCE_SIZE_MISMATCH', '原文件未完整下载');
    if (declared.expectedSha256) requireValue(await hashFile(partial) === declared.expectedSha256, 'SOURCE_HASH_MISMATCH', '原文件 SHA-256 与声明不同');
    await rename(partial, output);
  } finally { await sink.close(); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function validatedLocalReport(path: string, directory: string, metadata: UploadMetadata): Promise<ProcessedMedia | null> {
  try {
    const file = await lstat(path); requireValue(file.isFile() && !file.isSymbolicLink() && file.size < 32000, 'INVALID_LOCAL_REPORT', '本地处理报告无效');
    const report = LocalReportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    requireValue(report.metadata.kind === metadata.kind && report.metadata.bytes === metadata.expectedBytes && report.metadata.detectedMime === metadata.expectedMime && (!metadata.expectedSha256 || report.metadata.sha256 === metadata.expectedSha256), 'LOCAL_REPORT_MISMATCH', '本地报告与原文件声明不同');
    for (const variant of report.variants) {
      const item = resolve(variant.path); requireValue(isWithin(directory, item) && isWithin(await realpath(directory), await realpath(item)), 'INVALID_LOCAL_REPORT', '衍生文件必须位于本次私密目录内');
      const file = await lstat(item); requireValue(file.isFile() && !file.isSymbolicLink() && file.size === variant.bytes && await hashFile(item) === variant.sha256, 'LOCAL_REPORT_MISMATCH', '本地衍生文件已经发生变化');
    }
    return report;
  } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
}

export interface RunMediaOptions { assetId: string; client: MediaRunnerClient; privateRoot?: string; log?: (event: { status: string; assetId: string; role?: string; part?: number }) => void }
export async function runMedia(options: RunMediaOptions): Promise<{ assetId: string; status: 'ready' }> {
  const assetId = IdSchema.parse(options.assetId), client = options.client, prefix = `/api/v1/internal/processing/${assetId}`;
  const claim = ClaimSchema.parse(await api(client, `${prefix}/claim`, jsonRequest({})));
  requireValue(claim.assetId === assetId, 'CLAIM_MISMATCH', '服务返回的媒体任务不匹配');
  if (claim.state === 'ready') return { assetId, status: 'ready' };
  requireValue(claim.state !== 'failed', 'PROCESSING_FAILED', '此任务已失败，需先核对保留的中间文件与容量');
  const privateRoot = resolve(options.privateRoot || '.private-build'), directory = resolve(privateRoot, `media-${assetId}`);
  requireValue(isWithin(privateRoot, directory), 'INVALID_WORKSPACE', '媒体任务必须位于私密工作目录内');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  requireValue(!(await lstat(privateRoot)).isSymbolicLink() && !(await lstat(directory)).isSymbolicLink() && isWithin(await realpath(privateRoot), await realpath(directory)), 'INVALID_WORKSPACE', '私密工作目录不能越界或使用符号链接');
  const source = resolve(directory, 'source.upload'), reportPath = resolve(directory, 'report.json');
  const status = async (): Promise<Status> => { const value = StatusSchema.parse(await api(client, `${prefix}/status`)); requireValue(value.assetId === assetId && value.runId === claim.runId, 'RUN_MISMATCH', '处理状态不属于当前运行'); return value; };
  let report = await validatedLocalReport(reportPath, directory, claim.metadata);
  try {
    if (!report) {
      requireValue(claim.sourceUrl === `${prefix}/source`, 'SOURCE_URL_REJECTED', '私密原文件地址必须属于当前任务');
      // Remove only this runner's previous incomplete source; never a caller asset.
      await rm(source, { force: true });
      await streamSource(client, claim.sourceUrl, source, claim.metadata);
      report = await processMedia(source, claim.metadata, directory);
      await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    }
    const plannedVariants = [];
    for (const { path, ...variant } of report.variants) plannedVariants.push({ ...variant, ...await describeFileParts(path, variant.bytes) });
    const plan = { metadata: report.metadata, variants: plannedVariants };
    await api(client, `${prefix}/plan`, jsonRequest(plan));
    let remote = await status();
    for (const variant of report.variants) {
      let task = remote.variants.find(item => item.role === variant.role);
      requireValue(task && task.sha256 === variant.sha256 && task.bytes === variant.bytes, 'PLAN_MISMATCH', '服务端计划与本地版本不符');
      if (task.state === 'complete') continue;
      if (task.state !== 'completing') {
        const file = await open(variant.path, 'r');
        try {
          for (let partNumber = 1; partNumber <= task.totalParts; partNumber++) {
            const offset = (partNumber - 1) * task.partSize, length = Math.min(task.partSize, variant.bytes - offset), bytes = new Uint8Array(length);
            let read = 0; while (read < length) { const chunk = await file.read(bytes, read, length - read, offset + read); requireValue(chunk.bytesRead > 0, 'LOCAL_FILE_CHANGED', '上传时本地文件变短'); read += chunk.bytesRead; }
            const confirmed = task.parts.find(item => item.partNumber === partNumber);
            const partHash = await sha256Bytes(bytes);
            requireValue(task.partSha256[partNumber - 1] === partHash, 'LOCAL_FILE_CHANGED', '上传分片与已冻结计划不同');
            if (confirmed) { requireValue(confirmed.bytes === length && confirmed.sha256 === partHash, 'REMOTE_PART_MISMATCH', '已确认分片与本地文件不同'); continue; }
            try { await api(client, `${prefix}/parts/${variant.role}/${partNumber}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': String(length) }, body: bytes }); }
            catch (error) { remote = await status(); const recovered = remote.variants.find(item => item.role === variant.role)?.parts.find(item => item.partNumber === partNumber); if (!recovered || recovered.bytes !== length || recovered.sha256 !== await sha256Bytes(bytes)) throw error; }
            options.log?.({ status: 'part_uploaded', assetId, role: variant.role, part: partNumber });
          }
        } finally { await file.close(); }
      }
      try { await api(client, `${prefix}/complete/${variant.role}`, jsonRequest({})); }
      catch (error) { remote = await status(); task = remote.variants.find(item => item.role === variant.role); if (task?.state !== 'complete') throw error; }
      remote = await status(); options.log?.({ status: 'variant_verified', assetId, role: variant.role });
    }
    try { await api(client, `${prefix}/finish`, jsonRequest({})); }
    catch (error) { if ((await status()).state !== 'ready') throw error; }
    options.log?.({ status: 'ready', assetId }); return { assetId, status: 'ready' };
  } catch (error) {
    // Network failures leave resumable state. Only a locally confirmed invalid
    // source is terminal here; no quota is released by reporting failure.
    if (error instanceof MediaProcessingError || error instanceof z.ZodError) {
      const code = error instanceof MediaProcessingError ? error.code : 'INVALID_MEDIA_REPORT';
      await api(client, `${prefix}/fail`, jsonRequest({ code, message: '受控媒体处理未通过格式、解码或完整性验证。' })).catch(() => {});
    }
    throw error;
  }
}
async function sha256Bytes(bytes: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
/** Node/CI creates the trusted per-part manifest without buffering whole media. */
export async function describeFileParts(path: string, bytes: number, partSize = 5 * 1024 * 1024): Promise<{ partSha256: string[]; multipartEtag: string }> {
  requireValue(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 512000000 && partSize === 5 * 1024 * 1024, 'INVALID_PART_PLAN', '媒体分片计划大小无效');
  const file = await open(path, 'r'), hashes: string[] = [], multipart = createHash('md5');
  try {
    requireValue((await file.stat()).size === bytes, 'LOCAL_FILE_CHANGED', '生成分片计划时文件大小发生变化');
    for (let offset = 0; offset < bytes; offset += partSize) {
      const count = Math.min(partSize, bytes - offset), block = new Uint8Array(count); let read = 0;
      while (read < count) { const next = await file.read(block, read, count - read, offset + read); requireValue(next.bytesRead > 0, 'LOCAL_FILE_CHANGED', '生成分片计划时文件变短'); read += next.bytesRead; }
      hashes.push(await sha256Bytes(block));
      multipart.update(createHash('md5').update(block).digest());
    }
    return { partSha256: hashes, multipartEtag: `${multipart.digest('hex')}-${hashes.length}` };
  } finally { await file.close(); }
}

const CliStateSchema = z.object({ assetId: IdSchema, origin: z.string(), mode: z.enum(['local', 'github']), localRunId: z.string().uuid(), githubRunId: z.string().optional() }).strict();
export async function mediaRunnerCli(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, options: { asset: { type: 'string' }, origin: { type: 'string' }, 'auth-file': { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) { process.stdout.write('验证并处理私密媒体（不会发布内容）：\nnode --import tsx scripts/v3/media-runner.ts --asset <ID> --origin https://test.xvyin.com --auth-file <私有会话JSON>\nGitHub Actions 使用 OIDC，不传 --auth-file。\n'); return; }
  requireValue(values.asset && values.origin, 'INVALID_ARGUMENTS', '需要 --asset 与 --origin');
  const assetId = IdSchema.parse(values.asset), origin = validateOrigin(values.origin), mode = values['auth-file'] ? 'local' : 'github';
  requireValue(mode === 'local' || process.env.GITHUB_ACTIONS === 'true' && /^\d+$/.test(process.env.GITHUB_RUN_ID || ''), 'AUTH_REQUIRED', '本地执行需要私有管理员会话文件；GitHub 任务使用 OIDC');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), privateRoot = resolve(root, '.private-build'), directory = resolve(privateRoot, `media-${assetId}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  requireValue(!(await lstat(privateRoot)).isSymbolicLink() && !(await lstat(directory)).isSymbolicLink() && isWithin(await realpath(root), await realpath(directory)), 'INVALID_WORKSPACE', '私密任务目录无效');
  const statePath = resolve(directory, 'runner.json');
  let state: z.infer<typeof CliStateSchema>;
  try { const file = await lstat(statePath); requireValue(file.isFile() && !file.isSymbolicLink() && file.size < 4096, 'INVALID_RUNNER_STATE', '本地任务身份记录无效'); state = CliStateSchema.parse(JSON.parse(await readFile(statePath, 'utf8'))); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; state = { assetId, origin, mode, localRunId: randomUUID(), ...(mode === 'github' ? { githubRunId: process.env.GITHUB_RUN_ID! } : {}) }; await writeFile(statePath, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); }
  requireValue(state.assetId === assetId && state.origin === origin && state.mode === mode && (mode !== 'github' || state.githubRunId === process.env.GITHUB_RUN_ID), 'RUNNER_STATE_CONFLICT', '本地任务身份与当前执行方式不同');
  const credentials = values['auth-file'] ? await readCredentials(resolve(values['auth-file'])) : undefined;
  const client = createRunnerTransport({ origin, mode, localRunId: state.localRunId, credentials, requestTimeoutMs: 10 * 60 * 1000 });
  const result = await runMedia({ assetId, client, privateRoot, log: event => process.stdout.write(`${JSON.stringify(event)}\n`) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) mediaRunnerCli().catch(error => { process.stderr.write(`${JSON.stringify({ code: error instanceof MediaRunnerError || error instanceof MediaProcessingError ? error.code : 'MEDIA_RUNNER_FAILED', message: '媒体处理未完成；本地私密文件与服务端容量记录已保留，可核对后重试。' })}\n`); process.exitCode = 1; });
