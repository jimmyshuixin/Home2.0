import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import { PDFDocument } from 'pdf-lib'
import { processMedia, hashFile, validateVtt } from '../process-media'
import type { UploadMetadata } from '@xvyin/contracts'

let root: string
beforeAll(async () => { root = await mkdtemp(resolve(tmpdir(), 'xvyin-media-test-')) })
afterAll(async () => { sharp.cache(false); const rel = relative(resolve(tmpdir()), root); if (rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
async function declaration(path: string, kind: UploadMetadata['kind'], mime: UploadMetadata['expectedMime']): Promise<UploadMetadata> { return { originalName: 'qa-fixture', kind, expectedMime: mime, expectedBytes: (await stat(path)).size } as UploadMetadata }
function ffmpeg(args: string[]) { execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-nostdin', ...args], { windowsHide: true, timeout: 30_000 }) }

describe('real media processing', () => {
  it('validates and strips EXIF, rotates orientation, preserves ratio and never upscales', async () => {
    const input = resolve(root, 'orientation.jpg')
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#345344' } }).jpeg().withMetadata({ orientation: 6 }).toFile(input)
    const sourceHash = await hashFile(input)
    const output = await processMedia(input, { ...await declaration(input, 'image', 'image/jpeg'), expectedSha256: sourceHash }, resolve(root, 'image-output'))
    expect(output.variants.map((v) => v.role)).toEqual(['thumb', 'content', 'large'])
    for (const item of output.variants) {
      const metadata = await sharp(item.path).metadata()
      expect(metadata.exif).toBeUndefined(); expect(metadata.xmp).toBeUndefined()
      expect(metadata.width! / metadata.height!).toBeCloseTo(.75)
      expect(metadata.width).toBeLessThanOrEqual(600); expect(metadata.height).toBeLessThanOrEqual(800)
      expect(item.sha256).toBe(await hashFile(item.path))
    }
    expect(await hashFile(input)).toBe(sourceHash)
  })
  it('decodes a real WAV and produces playable AAC with verified duration', async () => {
    const input = resolve(root, 'tone.wav')
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', input])
    const result = await processMedia(input, await declaration(input, 'audio', 'audio/wav'), resolve(root, 'audio-output'))
    expect(result.metadata.kind).toBe('audio'); expect(result.variants[0]!.mime).toBe('audio/mp4')
    expect(result.variants[0]!.durationMs).toBeGreaterThanOrEqual(1000)
    expect(result.variants[0]!.durationMs).toBeLessThan(1500)
  })
  it('decodes a real video and produces complete MP4 and poster, below the upload ceiling', async () => {
    const input = resolve(root, 'moving.mp4')
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input])
    const result = await processMedia(input, await declaration(input, 'video', 'video/mp4'), resolve(root, 'video-output'))
    expect(result.variants.map((item) => item.role)).toEqual(['playback', 'poster'])
    expect(result.variants[0]!.width).toBe(640); expect(result.variants[0]!.height).toBe(360)
    expect(result.variants[0]!.bytes).toBeLessThanOrEqual(512_000_000)
    expect((await sharp(result.variants[1]!.path).metadata()).format).toBe('webp')
  })
  it('rejects a renamed file, size mismatch, hash mismatch and a 512 MB overflow before decoding', async () => {
    const input = resolve(root, 'not-an-image.jpg'); await writeFile(input, '<script>not an image</script>')
    await expect(processMedia(input, await declaration(input, 'image', 'image/jpeg'), resolve(root, 'bad-type'))).rejects.toMatchObject({ code: 'UPLOAD_TYPE_MISMATCH' })
    const image = resolve(root, 'small.png'); await sharp({ create: { width: 10, height: 10, channels: 3, background: '#123456' } }).png().toFile(image)
    await expect(processMedia(image, { ...await declaration(image, 'image', 'image/png'), expectedBytes: 1 }, resolve(root, 'bad-size'))).rejects.toMatchObject({ code: 'UPLOAD_MISMATCH' })
    await expect(processMedia(image, { ...await declaration(image, 'image', 'image/png'), expectedSha256: '0'.repeat(64) }, resolve(root, 'bad-hash'))).rejects.toMatchObject({ code: 'UPLOAD_HASH_MISMATCH' })
    await expect(processMedia('unread', { kind: 'video', originalName: 'large.mp4', expectedMime: 'video/mp4', expectedBytes: 512_000_001 }, resolve(root, 'too-large'))).rejects.toHaveProperty('name', 'ZodError')
  })
  it('parses a real PDF and rejects a PDF with JavaScript', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage([300, 400])
    const input = resolve(root, 'static.pdf'); await writeFile(input, await pdf.save())
    const result = await processMedia(input, await declaration(input, 'file', 'application/pdf'), resolve(root, 'pdf-output'))
    expect(result.variants[0]!.role).toBe('download')
    expect(await readFile(result.variants[0]!.path)).toEqual(await readFile(input))
    pdf.addJavaScript('qa-script', 'app.alert("test")')
    const active = resolve(root, 'active.pdf'); await writeFile(active, await pdf.save())
    await expect(processMedia(active, await declaration(active, 'file', 'application/pdf'), resolve(root, 'pdf-rejected'))).rejects.toMatchObject({ code: 'ACTIVE_PDF' })
  })
  it('validates UTF-8 captions and exposes a distinct captions role', async () => {
    const input = resolve(root, 'captions.vtt'); await writeFile(input, 'WEBVTT\n\n00:00.000 --> 00:01.000\n测试字幕\n')
    const result = await processMedia(input, await declaration(input, 'file', 'text/vtt'), resolve(root, 'vtt-output'))
    expect(result.variants.map((v) => v.role)).toEqual(['download', 'captions'])
    expect(() => validateVtt('WEBVTT\n\n00:02.000 --> 00:01.000\n时间错误\n')).toThrow()
  })
  it('rejects embedded-file names inside a PDF stream dictionary', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage([300, 400]); pdf.context.register(pdf.context.stream('test attachment', { Type: 'EmbeddedFile' }))
    const input = resolve(root, 'embedded-stream.pdf'); await writeFile(input, await pdf.save())
    await expect(processMedia(input, await declaration(input, 'file', 'application/pdf'), resolve(root, 'embedded-rejected'))).rejects.toMatchObject({ code: 'ACTIVE_PDF' })
  })
})
