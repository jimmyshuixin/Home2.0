import { createReadStream, createWriteStream, constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import sharp from 'sharp'
import { extractPhotographyMetadata } from './photo-metadata'
import { z } from 'zod'
import { UploadMetadataSchema, DetectedMediaMetadataSchema, PublicMediaVariantSchema, MEDIA_LIMITS, type UploadMetadata, type DetectedMediaMetadata, type MediaVariantRoleSchema, type AllowedMimeSchema } from '@xvyin/contracts'

// Cached libvips file handles can prevent Windows runners from removing completed
// job directories. Keep decoded-operation caching, but retain no open files.
sharp.cache({ files: 0 })

type VariantRole = z.infer<typeof MediaVariantRoleSchema>
type AllowedMime = z.infer<typeof AllowedMimeSchema>
export interface ProcessedVariant { role: VariantRole; path: string; mime: AllowedMime; bytes: number; sha256: string; width?: number; height?: number; durationMs?: number }
export interface ProcessedMedia { metadata: DetectedMediaMetadata; variants: ProcessedVariant[] }
export class MediaProcessingError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'MediaProcessingError' } }
function check(condition: unknown, code: string, message: string): asserts condition { if (!condition) throw new MediaProcessingError(code, message) }

/** Streaming SHA-256: video input is never buffered into the Node heap. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk)
  return hash.digest('hex')
}
async function copyAndHash(input: string, output: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(input, { highWaterMark: 1024 * 1024 }), new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk) } }), createWriteStream(output, { flags: 'wx', mode: 0o600 }))
  return hash.digest('hex')
}
async function head(path: string): Promise<Uint8Array> { const file = await open(path, 'r'); try { const buffer = new Uint8Array(4096); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); return buffer.subarray(0, bytesRead) } finally { await file.close() } }
function magicMime(bytes: Uint8Array, declared: UploadMetadata): AllowedMime | null {
  const ascii = (start: number, end: number) => new TextDecoder('ascii').decode(bytes.subarray(start, end))
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return declared.expectedMime === 'audio/x-wav' ? 'audio/x-wav' : 'audio/wav'
  if (ascii(4, 8) === 'ftyp') return declared.kind === 'video' ? 'video/mp4' : 'audio/mp4'
  if ([0x1a, 0x45, 0xdf, 0xa3].every((value, i) => bytes[i] === value) && ascii(0, 128).includes('webm')) return 'video/webm'
  if (ascii(0, 4) === 'OggS') return 'audio/ogg'
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg'
  if (bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) return 'audio/aac'
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 6) !== 0) return 'audio/mpeg'
  if (ascii(0, 5) === '%PDF-') return 'application/pdf'
  if (declared.kind === 'file' && ['text/plain', 'text/vtt'].includes(declared.expectedMime)) return declared.expectedMime
  return null
}

function executable(name: 'ffmpeg' | 'ffprobe'): string { return process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'] || name }
async function command(binary: string, args: string[], timeoutMs = 120_000, outputLimit?: { path: string; bytes: number }): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false, tooMuchOutput = false, oversizedFile = false, checkingSize = false
    const stdoutDecoder = new TextDecoder(), stderrDecoder = new TextDecoder()
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    const sizeTimer = outputLimit ? setInterval(() => {
      if (checkingSize) return
      checkingSize = true
      void stat(outputLimit.path).then(file => { if (file.size > outputLimit.bytes) { oversizedFile = true; child.kill('SIGKILL') } }).catch(() => {}).finally(() => { checkingSize = false })
    }, 250) : undefined
    child.stdout.on('data', (chunk: Uint8Array) => { if (stdout.length + chunk.length > 2_000_000) { tooMuchOutput = true; child.kill('SIGKILL') } else stdout += stdoutDecoder.decode(chunk, { stream: true }) })
    child.stderr.on('data', (chunk: Uint8Array) => { stderr = (stderr + stderrDecoder.decode(chunk, { stream: true })).slice(-64_000) })
    child.on('error', () => { clearTimeout(timer); clearInterval(sizeTimer); reject(new MediaProcessingError('PROCESSOR_UNAVAILABLE', '找不到媒体处理程序，请配置 FFMPEG_PATH / FFPROBE_PATH。')) })
    child.on('close', (code) => {
      clearTimeout(timer)
      clearInterval(sizeTimer)
      if (oversizedFile) reject(new MediaProcessingError('PLAYBACK_TOO_LARGE', '完整播放版本超过大小限制，请压缩后重新上传；不会截断发布。'))
      else if (timedOut) reject(new MediaProcessingError('PROCESSING_TIMEOUT', '媒体处理超过本次任务时限，原文件保持不变。'))
      else if (tooMuchOutput) reject(new MediaProcessingError('INVALID_MEDIA', '媒体包含过多轨道或无效元数据。'))
      else if (code !== 0) reject(new MediaProcessingError('MEDIA_DECODE_FAILED', `媒体解码失败：${stderr.slice(-1500).replaceAll(/https?:\/\/\S+/g, '[URL]')}`))
      else accept(stdout)
    })
  })
}
interface Probe { format: { duration?: string; format_name?: string }; streams: Array<{ index: number; codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; disposition?: { attached_pic?: number } }> }
async function probe(path: string): Promise<Probe> { return JSON.parse(await command(executable('ffprobe'), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=format_name,duration:stream=index,codec_type,codec_name,width,height,duration:stream_disposition=attached_pic', '-of', 'json', path])) as Probe }
function duration(probeResult: Probe): number { const seconds = Number(probeResult.format.duration || probeResult.streams.find((stream) => stream.duration)?.duration); check(Number.isFinite(seconds) && seconds > 0, 'INVALID_DURATION', '无法验证媒体时长。'); return Math.round(seconds * 1000) }
async function variant(path: string, role: VariantRole, mime: AllowedMime, metadata: { width?: number; height?: number; durationMs?: number } = {}): Promise<ProcessedVariant> {
  const bytes = (await stat(path)).size
  PublicMediaVariantSchema.parse({ role, url: '/validated-output', mime, bytes, ...metadata })
  return { role, path, mime, bytes, sha256: await hashFile(path), ...metadata }
}
function inside(parent: string, path: string): boolean { const rel = relative(parent, path); return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel) }

export function validateVtt(text: string): void {
  check(/^WEBVTT(?:[ \t][^\r\n]*)?\n(?:\n|$)/.test(text), 'INVALID_CAPTIONS', '字幕必须以 WEBVTT 标记及空行开始。')
  const timestamp = (value: string) => { const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value); check(match, 'INVALID_CAPTIONS', '字幕时间戳无效。'); return (Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + Number(match[4]) }
  for (const block of text.split(/\n{2,}/).slice(1)) {
    if (!block.trim() || /^NOTE(?:[ \t\n]|$)/.test(block)) continue
    check(!/^(STYLE|REGION)(?:\n|$)/.test(block), 'UNSUPPORTED_CAPTIONS', '首期字幕不支持 STYLE / REGION，请导出普通 WebVTT。')
    const lines = block.split('\n'), timeIndex = lines[0]?.includes('-->') ? 0 : 1
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[timeIndex] || '')
    check(match && lines.length > timeIndex + 1, 'INVALID_CAPTIONS', '字幕段需要有效起止时间和正文。')
    check(timestamp(match[2]!) > timestamp(match[1]!), 'INVALID_CAPTIONS', '字幕结束时间必须晚于开始时间。')
    check(!/<\/?(?:script|iframe|style|object|embed)\b/i.test(lines.slice(timeIndex + 1).join('\n')), 'INVALID_CAPTIONS', '字幕不能包含活动内容。')
  }
}
async function validatePdf(path: string): Promise<void> {
  // File uploads are capped at 20 MiB. Unlike video, bounded PDF parsing can use a
  // full buffer; object streams are parsed so an active-action scan is structural.
  const { PDFDocument, PDFDict, PDFName, PDFArray, PDFStream } = await import('pdf-lib')
  const document = await PDFDocument.load(await readFile(path), { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false })
  check(!document.isEncrypted && document.getPageCount() > 0 && document.getPageCount() <= 5000, 'INVALID_PDF', 'PDF 必须未加密且包含可读取页面。')
  const forbidden = new Set(['JavaScript', 'JS', 'OpenAction', 'AA', 'Launch', 'EmbeddedFiles', 'EmbeddedFile', 'RichMedia', 'XFA', 'AcroForm'])
  const seen = new Set<unknown>(), stack: unknown[] = document.context.enumerateIndirectObjects().map(([, object]) => object)
  while (stack.length) {
    const object = stack.pop(); if (!object || seen.has(object)) continue; seen.add(object)
    check(seen.size < 100_000, 'INVALID_PDF', 'PDF 对象数量超出安全处理范围。')
    if (object instanceof PDFName) check(!forbidden.has(object.decodeText()), 'ACTIVE_PDF', 'PDF 包含脚本、自动动作、表单或嵌入附件，请导出普通静态 PDF。')
    else if (object instanceof PDFDict) for (const [key, value] of object.entries()) { stack.push(key, value) }
    else if (object instanceof PDFArray) stack.push(...object.asArray())
    else if (object instanceof PDFStream) stack.push(object.dict)
  }
}

export async function processMedia(inputPath: string, declaration: UploadMetadata, outDir: string): Promise<ProcessedMedia> {
  const declared = UploadMetadataSchema.parse(declaration), original = resolve(inputPath), root = resolve(outDir)
  const inputStat = await lstat(original)
  check(inputStat.isFile() && !inputStat.isSymbolicLink(), 'INVALID_INPUT_FILE', '输入必须是普通文件，不能是目录或符号链接。')
  check(inputStat.size === declared.expectedBytes, 'UPLOAD_MISMATCH', '实际文件大小与上传声明不一致。')
  const detectedMime = magicMime(await head(original), declared)
  check(detectedMime === declared.expectedMime, 'UPLOAD_TYPE_MISMATCH', '文件实际格式与声明的 MIME 不一致。')
  await mkdir(root, { recursive: true })
  const work = await mkdtemp(resolve(root, 'processed-'))
  check(inside(root, work), 'INVALID_OUTPUT_PATH', '输出目录必须位于指定的处理目录内。')
  const staged = resolve(work, 'source.upload')
  try {
    const sha256 = await copyAndHash(original, staged)
    check((await stat(staged)).size === declared.expectedBytes, 'UPLOAD_MISMATCH', '复制期间输入文件发生变化。')
    check(magicMime(await head(staged), declared) === declared.expectedMime, 'UPLOAD_TYPE_MISMATCH', '复制后的实际格式与声明不一致。')
    check(!declared.expectedSha256 || sha256 === declared.expectedSha256, 'UPLOAD_HASH_MISMATCH', '文件 SHA-256 与上传声明不一致。')
    const base = { kind: declared.kind, detectedMime, bytes: inputStat.size, sha256 }, variants: ProcessedVariant[] = []
    let metadata: DetectedMediaMetadata
    if (declared.kind === 'image') {
      // One file and one derivative at a time. Libvips' operation cache is
      // bounded; pixel and decoder time limits also apply to highly compressed inputs.
      sharp.cache({ memory: 32, files: 0, items: 20 }); sharp.concurrency(1)
      const details = await sharp(staged, { limitInputPixels: MEDIA_LIMITS.imagePixels, failOn: 'error', sequentialRead: true }).timeout({ seconds: 120 }).metadata()
      check(details.width && details.height && details.width * details.height <= MEDIA_LIMITS.imagePixels, 'IMAGE_PIXEL_LIMIT', '图片不得超过 1.5 亿像素。')
      check((details.pages || 1) === 1, 'ANIMATED_IMAGE_UNSUPPORTED', '请上传静态图片；不会静默丢弃动画帧。')
      for (const [role, size] of [['thumb', 384], ['content', 960], ['large', 1600]] as const) {
        const path = resolve(work, `${role}.webp`)
        const info = await sharp(staged, { limitInputPixels: MEDIA_LIMITS.imagePixels, failOn: 'error', sequentialRead: true }).rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true }).webp({ quality: role === 'thumb' ? 80 : 85, effort: 4 }).timeout({ seconds: 120 }).toFile(path)
        variants.push(await variant(path, role, 'image/webp', { width: info.width, height: info.height }))
      }
      const photography = extractPhotographyMetadata(details.exif), rotated = (details.orientation || 1) >= 5
      metadata = DetectedMediaMetadataSchema.parse({ ...base, width: rotated ? details.height : details.width, height: rotated ? details.width : details.height, ...(photography ? { photography } : {}) })
    } else if (declared.kind === 'audio' || declared.kind === 'video') {
      const info = await probe(staged), durationMs = duration(info)
      const visual = info.streams.filter((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
      const audio = info.streams.filter((stream) => stream.codec_type === 'audio')
      check(declared.kind === 'video' ? visual.length > 0 : visual.length === 0 && audio.length > 0, 'MEDIA_KIND_MISMATCH', '媒体轨道与声明的音频/视频类型不符。')
      const path = resolve(work, declared.kind === 'video' ? 'playback.mp4' : 'playback.m4a')
      const args = ['-v', 'error', '-nostdin', '-xerror', '-err_detect', 'explode', '-threads', '2', '-protocol_whitelist', 'file,pipe', '-i', staged, '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn']
      if (declared.kind === 'video') args.push('-map', `0:${visual[0]!.index}`, '-map', '0:a:0?', '-filter_threads', '2', '-vf', "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1", '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p')
      else args.push('-map', '0:a:0', '-vn')
      args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', '-n', path)
      await command(executable('ffmpeg'), args, 45 * 60 * 1000, { path, bytes: declared.kind === 'video' ? MEDIA_LIMITS.videoBytes : MEDIA_LIMITS.audioBytes })
      const outputInfo = await probe(path), outputDuration = duration(outputInfo)
      check(Math.abs(outputDuration - durationMs) <= Math.max(500, durationMs * .001), 'DURATION_MISMATCH', '转码后时长不一致，拒绝发布可能被截断的媒体。')
      check((await stat(path)).size <= (declared.kind === 'video' ? MEDIA_LIMITS.videoBytes : MEDIA_LIMITS.audioBytes), 'PLAYBACK_TOO_LARGE', '完整播放版本超过大小限制，请压缩后重新上传；不会截断视频。')
      const outputVideo = outputInfo.streams.find((stream) => stream.codec_type === 'video')
      const playback = await variant(path, 'playback', declared.kind === 'video' ? 'video/mp4' : 'audio/mp4', { durationMs: outputDuration, ...(outputVideo ? { width: outputVideo.width, height: outputVideo.height } : {}) })
      check(playback.bytes <= (declared.kind === 'video' ? MEDIA_LIMITS.videoBytes : MEDIA_LIMITS.audioBytes), 'PLAYBACK_TOO_LARGE', '完整播放版本超过大小限制，请压缩后重新上传；不会截断视频。')
      variants.push(playback)
      if (declared.kind === 'video') {
        const poster = resolve(work, 'poster.webp')
        await command(executable('ffmpeg'), ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', path, '-map', '0:v:0', '-frames:v', '1', '-c:v', 'libwebp', '-quality', '85', '-map_metadata', '-1', '-n', poster])
        const image = await sharp(poster).metadata()
        variants.push(await variant(poster, 'poster', 'image/webp', { width: image.width, height: image.height }))
        metadata = DetectedMediaMetadataSchema.parse({ ...base, width: visual[0]!.width, height: visual[0]!.height, durationMs })
      } else metadata = DetectedMediaMetadataSchema.parse({ ...base, durationMs })
    } else {
      if (detectedMime === 'application/pdf') await validatePdf(staged)
      else {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(staged)).replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
        check(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text), 'INVALID_TEXT', '文本必须是有效 UTF-8，不能包含二进制控制字符。')
        if (detectedMime === 'text/vtt') validateVtt(text)
      }
      const extension = detectedMime === 'application/pdf' ? 'pdf' : detectedMime === 'text/vtt' ? 'vtt' : 'txt'
      const path = resolve(work, `download.${extension}`)
      await copyFile(staged, path, constants.COPYFILE_EXCL)
      variants.push(await variant(path, 'download', detectedMime))
      if (detectedMime === 'text/vtt') variants.push(await variant(path, 'captions', detectedMime))
      metadata = DetectedMediaMetadataSchema.parse(base)
    }
    await rm(staged) // Only our immutable processing copy; never the caller's input.
    return { metadata, variants }
  } catch (error) {
    check(inside(root, work), 'INVALID_CLEANUP_PATH', '拒绝清理指定输出目录之外的路径。')
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    if (error instanceof MediaProcessingError || error instanceof z.ZodError) throw error
    throw new MediaProcessingError('MEDIA_PROCESSING_FAILED', error instanceof Error ? error.message : '媒体处理失败。')
  }
}

async function main() {
  const options = new Map<string, string>(), args = process.argv.slice(2)
  check(args.length === 8, 'INVALID_ARGUMENTS', '需要 --input 文件 --metadata JSON文件 --output 目录 --report JSON文件')
  for (let i = 0; i < args.length; i += 2) { check(['--input', '--metadata', '--output', '--report'].includes(args[i]!), 'INVALID_ARGUMENTS', '包含未知参数。'); options.set(args[i]!, args[i + 1]!) }
  check(options.size === 4, 'INVALID_ARGUMENTS', '参数不可重复。')
  const metadata = UploadMetadataSchema.parse(JSON.parse(await readFile(resolve(options.get('--metadata')!), 'utf8')))
  const result = await processMedia(options.get('--input')!, metadata, options.get('--output')!)
  const report = resolve(options.get('--report')!); await mkdir(dirname(report), { recursive: true }); await writeFile(report, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ status: 'ready', report, variants: result.variants.length })}\n`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`${JSON.stringify({ code: error instanceof MediaProcessingError ? error.code : 'MEDIA_PROCESSING_FAILED', message: error instanceof Error ? error.message : '媒体处理失败。' })}\n`); process.exitCode = 1 })
