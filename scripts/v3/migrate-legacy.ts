import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { z } from 'zod'
import {
  AlbumDraftSchema, CalendarDateSchema, CreationDraftSchema, FitnessSettingsDraftSchema,
  HttpsUrlSchema, IdSchema, PlaylistDraftSchema, RichTextDocumentSchema, SafeHrefSchema,
  SiteSettingsSchema, UploadMetadataSchema, type ContentBlock, type RichInline,
  type RichTextDocument, type RichTextMark,
} from '@xvyin/contracts'

/** Local inventory only: this module has no HTTP client, authentication, upload or publish operation. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/u)
export const AssetMappingSchema = z.object({
  schemaVersion: z.literal(1),
  assets: z.array(z.object({
    source: z.string().min(1).max(4096), assetId: IdSchema,
    kind: z.enum(['image', 'audio']), sourceSha256: SHA256,
  }).strict()).max(2000),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.assets.map(asset => asset.source)).size !== value.assets.length) {
    ctx.addIssue({ code: 'custom', path: ['assets'], message: 'Duplicate source mapping' })
  }
  const identity = new Map<string, string>()
  for (const asset of value.assets) {
    const signature = `${asset.kind}:${asset.sourceSha256}`, existing = identity.get(asset.assetId)
    if (existing !== undefined && existing !== signature) ctx.addIssue({ code: 'custom', path: ['assets'], message: 'One asset ID cannot identify different source bytes or media kinds' })
    identity.set(asset.assetId, signature)
  }
})
interface SourceFile { path: string; bytes: number; sha256: string }
interface MediaSource {
  source: string; kind: 'image' | 'audio'; local: boolean; bytes: number | null; sha256: string | null
  usedBy: string[]; mappedAssetId: string | null; mappingVerified: 'local-source-hash-only' | 'remote-unverified' | null
  uploadDeclaration: z.infer<typeof UploadMetadataSchema> | null
}
type Draft = z.infer<typeof SiteSettingsSchema> | z.infer<typeof FitnessSettingsDraftSchema>
  | z.infer<typeof CreationDraftSchema> | z.infer<typeof AlbumDraftSchema> | z.infer<typeof PlaylistDraftSchema>
interface Candidate {
  key: string; target: 'siteSettings' | 'fitnessSettings' | 'creation' | 'album' | 'playlist'
  state: 'ready-draft' | 'blocked'; draft: Draft | null; sources: string[]; requiredAssets: string[]
  sourceDate: { value: string; source: string; pointer: string } | null
  blockers: string[]; notes: string[]
}
export interface MigrationManifest {
  schemaVersion: 1
  audit: { generatedAt: string; checkoutHead: string; sourceFiles: SourceFile[]; originalsUnchanged: true; publicContentExists: boolean }
  policy: { writesRemote: false; publishes: false; mediaBytesCopied: false; fitnessStartDate: null; assetReadinessVerifiedRemotely: false }
  counts: { candidates: number; readyDrafts: number; blockedCandidates: number; articles: number; localPlaylists: number; uniqueLocalAudio: number; localTrackReferences: number; fallbackTrackReferences: number; matchedFallbackPlaylists: number; referencedPhotography: number; unclassifiedPhotos: number; requiredMediaSources: number; requiredLocalBytes: number }
  candidates: Candidate[]; media: MediaSource[]
  aliases: Array<{ source: string; equivalentTo: string[]; explanation: string }>
  unconverted: Array<{ sources: string[]; reason: string }>
  unusedMappings: string[]
}

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
function normalizeSource(source: string): string {
  if (source.startsWith('https://')) return HttpsUrlSchema.parse(source)
  const result = source.replace(/^\.\//u, '').replace(/^\//u, '')
  check(result.startsWith('content/') && !result.includes('\\') && !result.includes('\0')
    && result.split('/').every(part => part !== '' && part !== '.' && part !== '..'), `Unsafe source path: ${source}`)
  return result
}
async function checkedPath(root: string, path: string): Promise<string> {
  const absolute = resolve(root, path), rel = relative(root, absolute)
  check(rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), `Path outside repository: ${path}`)
  let cursor = root
  check(!(await lstat(root)).isSymbolicLink(), 'Repository must not be a symlink')
  for (const segment of rel.split(sep)) {
    cursor = resolve(cursor, segment)
    check(!(await lstat(cursor)).isSymbolicLink(), `Symlink source/output refused: ${path}`)
  }
  return absolute
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function walk(root: string, directory: string): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(await checkedPath(root, directory), { withFileTypes: true })) {
    const child = `${directory}/${entry.name}`
    check(!entry.isSymbolicLink(), `Symlink source refused: ${child}`)
    if (entry.isDirectory()) output.push(...await walk(root, child))
    else if (entry.isFile()) output.push(child)
    else throw new Error(`Non-regular source refused: ${child}`)
  }
  return output.sort()
}
function technicalId(prefix: string, source: string): string {
  return `${prefix}-${createHash('sha256').update(source).digest('hex').slice(0, 20)}`
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression {
  const matches = object.properties.filter(item => ts.isPropertyAssignment(item)
    && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name)
  check(matches.length === 1 && ts.isPropertyAssignment(matches[0]!), `Expected one static property: ${name}`)
  return matches[0]!.initializer
}
/** Only inspect AST string literals and import.meta.env.X || 'literal' fallbacks. Never evaluate JavaScript. */
export function extractSiteDefaults(source: string) {
  const parsed = ts.createSourceFile('site.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let config: ts.ObjectLiteralExpression | undefined
  for (const statement of parsed.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'siteConfig') {
        check(!config && declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer), 'siteConfig must be a unique literal object')
        config = declaration.initializer
      }
    }
  }
  check(config, 'Missing siteConfig')
  const literal = (node: ts.Expression): string => {
    if (ts.isStringLiteral(node)) return node.text
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken
      && /^import\.meta\.env\.[A-Z0-9_]+$/u.test(node.left.getText(parsed)) && ts.isStringLiteral(node.right)) return node.right.text
    throw new Error('Unsupported dynamic configuration: cannot infer a checked-in default')
  }
  const music = property(config, 'music'); check(ts.isObjectLiteralExpression(music), 'music must be a literal object')
  return { githubProfile: literal(property(config, 'githubProfile')), music: {
    source: literal(property(music, 'server')), sourceType: literal(property(music, 'type')),
    sourceId: literal(property(music, 'playlistId')), name: literal(property(music, 'playlistName')),
  } }
}

function decodeEntities(input: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', raquo: '»' }
  return input.replace(/&([^;\s]+);/gu, (_match, entity: string) => {
    if (named[entity]) return named[entity]
    if (/^#(?:x[0-9a-f]+|[0-9]+)$/iu.test(entity)) {
      const value = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
      check(value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff), 'Invalid HTML character entity')
      return String.fromCodePoint(value)
    }
    throw new Error(`Unsupported HTML entity: ${entity}`)
  })
}
interface HtmlElement { tag: string; attrs: Record<string, string>; children: Array<HtmlElement | string> }
/** Deliberately small, fail-closed legacy HTML reader, not a general HTML sanitizer/parser. */
function parseLegacyHtml(source: string): HtmlElement {
  const root: HtmlElement = { tag: 'root', attrs: {}, children: [] }, stack = [root]
  const tokens = source.match(/<[^>]*>|[^<]+/gu) ?? []
  check(tokens.join('') === source, 'Malformed HTML')
  for (const token of tokens) {
    const parent = stack[stack.length - 1]!
    if (!token.startsWith('<')) { parent.children.push(decodeEntities(token).replace(/[\t\r\n\f ]+/gu, ' ')); continue }
    const close = /^<\/([a-z][a-z0-9]*)\s*>$/iu.exec(token)
    if (close) { check(stack.length > 1 && parent.tag === close[1]!.toLowerCase(), 'Unbalanced HTML'); stack.pop(); continue }
    const start = /^<([a-z][a-z0-9]*)([\s\S]*?)>$/iu.exec(token)
    check(start, 'Comments, declarations and malformed tags are not supported')
    const tag = start[1]!.toLowerCase(), rest = start[2]!, attrs: Record<string, string> = {}
    check(['div', 'p', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'strong', 'b', 'em', 'i', 'br'].includes(tag), `Unsupported legacy HTML tag: ${tag}`)
    let consumed = 0
    const attrPattern = /\s+([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/giy
    while (consumed < rest.length) {
      attrPattern.lastIndex = consumed
      const attr = attrPattern.exec(rest)
      if (!attr) { check(/^\s*\/?\s*$/u.test(rest.slice(consumed)) && (tag === 'br' || !rest.includes('/')), 'Unsupported HTML attribute syntax'); break }
      const name = attr[1]!.toLowerCase(), value = decodeEntities(attr[2] ?? attr[3] ?? '')
      check(!(name in attrs) && ['class', 'style', ...(tag === 'a' ? ['href', 'target', 'rel'] : [])].includes(name), `Unsupported HTML attribute: ${name}`)
      attrs[name] = value; consumed = attrPattern.lastIndex
    }
    if (tag === 'a') { check(attrs.href, 'Link has no URL'); SafeHrefSchema.parse(attrs.href) }
    const element = { tag, attrs, children: [] }; parent.children.push(element)
    if (tag !== 'br') stack.push(element)
  }
  check(stack.length === 1, 'Unclosed legacy HTML tag')
  return root
}
function trimInline(content: RichInline[]): RichInline[] {
  const first = content[0], last = content[content.length - 1]
  if (first?.type === 'text') first.text = first.text.replace(/^ +/u, '')
  if (last?.type === 'text') last.text = last.text.replace(/ +$/u, '')
  return content.filter(node => node.type !== 'text' || node.text !== '')
}
export function convertLegacyAbout(source: string): RichTextDocument {
  const document: RichTextDocument = { type: 'doc', content: [] }
  const inline = (children: HtmlElement['children'], marks: RichTextMark[] = []): RichInline[] => children.flatMap(child => {
    if (typeof child === 'string') return child === '' ? [] : [{ type: 'text', text: child, ...(marks.length ? { marks } : {}) } as RichInline]
    if (child.tag === 'br') return [{ type: 'hardBreak' } as RichInline]
    let mark: RichTextMark
    if (child.tag === 'a') mark = { type: 'link', attrs: { href: child.attrs.href! } }
    else if (['b', 'strong'].includes(child.tag)) mark = { type: 'bold' }
    else if (['i', 'em'].includes(child.tag)) mark = { type: 'italic' }
    else throw new Error(`Block inside inline legacy HTML: ${child.tag}`)
    return inline(child.children, [...marks, mark])
  })
  const blocks = (children: HtmlElement['children']) => {
    for (const child of children) {
      if (typeof child === 'string') { check(!child.trim(), 'Bare text outside legacy HTML block'); continue }
      if (child.tag === 'div') { blocks(child.children); continue }
      check(['p', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(child.tag), `Unsupported top-level legacy HTML: ${child.tag}`)
      const content = trimInline(inline(child.children))
      if (/^h[1-6]$/u.test(child.tag)) document.content.push({ type: 'heading', attrs: { level: Number(child.tag[1]) }, content })
      else document.content.push({ type: 'paragraph', content })
    }
  }
  blocks(parseLegacyHtml(source).children)
  return RichTextDocumentSchema.parse(document)
}

interface MarkdownPart { type: 'heading' | 'paragraph' | 'quote' | 'image'; text: string; source?: string; level?: number }
/** Accept the existing article's heading + image, plus plain paragraphs/quotes; reject unknown syntax. */
export function parseLegacyMarkdown(source: string): MarkdownPart[] {
  const output: MarkdownPart[] = []
  let previousParagraph = false
  for (const raw of source.replace(/\r\n/gu, '\n').split('\n')) {
    const line = raw.trim()
    if (!line) { previousParagraph = false; continue }
    const image = /^!\[([^\]]+)\]\((https:\/\/[^\s)]+|\.?\/?content\/[^)]+)\)$/u.exec(line)
    if (image) { output.push({ type: 'image', text: image[1]!, source: normalizeSource(image[2]!) }); previousParagraph = false; continue }
    const heading = /^(#{1,6}) (.+)$/u.exec(line), quote = /^> (.+)$/u.exec(line)
    const text = heading?.[2] ?? quote?.[1] ?? line
    check(!/[<>`*\[\]]/u.test(text) && !/^[-+]|^\d+[.)]\s|^#{1,6}(?:\s|$)|^!|^>/u.test(text), 'Unsupported Markdown; preserve source for manual conversion')
    if (heading) output.push({ type: 'heading', text, level: heading[1]!.length })
    else if (quote) output.push({ type: 'quote', text })
    else {
      const last = output[output.length - 1]
      if (previousParagraph && last?.type === 'paragraph' && raw === line) last.text += `\n${text}`
      else output.push({ type: 'paragraph', text })
    }
    previousParagraph = !heading && !quote
  }
  return output
}

const LegacyTrackSchema = z.object({ name: z.string(), artist: z.string(), url: z.string(), cover: z.string(), lrc: z.literal('') }).strict()
const LegacyPlaylistsSchema = z.array(z.object({ id: z.string(), name: z.string(), file: z.string() }).strict())
const LegacyArticlesSchema = z.array(z.object({ id: z.union([z.string(), z.number().int()]), title: z.string(), date: CalendarDateSchema.nullable().optional(), category: z.string(), filePath: z.string() }).strict())

export async function buildLegacyMigration(root: string = REPO_ROOT, mappingInput: unknown = { schemaVersion: 1, assets: [] }): Promise<MigrationManifest> {
  root = resolve(root)
  const mapping = AssetMappingSchema.parse(mappingInput)
  for (const entry of mapping.assets) check(normalizeSource(entry.source) === entry.source, 'Mappings must use canonical content/... paths or exact HTTPS source URLs')
  const sourcePaths = [...await walk(root, 'content'), 'src/data/site.js', 'src/App.vue'].sort()
  const sourceFiles: SourceFile[] = []
  for (const path of sourcePaths) {
    const absolute = await checkedPath(root, path)
    sourceFiles.push({ path, bytes: (await lstat(absolute)).size, sha256: await hashFile(absolute) })
  }
  const ledger = new Map(sourceFiles.map(file => [file.path, file]))
  const consumed = new Set(['src/data/site.js', 'src/App.vue']), media = new Map<string, MediaSource>(), candidates: Candidate[] = []
  const text = async (path: string) => { check(ledger.has(path), `Source is absent from original ledger: ${path}`); consumed.add(path); return readFile(await checkedPath(root, path), 'utf8') }
  const json = async (path: string): Promise<unknown> => JSON.parse(await text(path))
  const requireAsset = (source: string, kind: 'image' | 'audio', candidate: Candidate): string | undefined => {
    source = normalizeSource(source)
    candidate.requiredAssets.push(source)
    const file = ledger.get(source), local = !source.startsWith('https://')
    if (local) consumed.add(source)
    check(!local || file, `Missing referenced local media: ${source}`)
    const entry = mapping.assets.find(item => item.source === source)
    if (entry) { check(entry.kind === kind, `Wrong mapped kind: ${source}`); check(!file || entry.sourceSha256 === file.sha256, `Mapped source hash differs: ${source}`) }
    const existing = media.get(source)
    if (existing) { check(existing.kind === kind, `Source has conflicting media roles: ${source}`); existing.usedBy.push(candidate.key) }
    else {
      const mime = ({ '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' } as const)[extname(source).toLowerCase() as '.mp3']
      media.set(source, { source, kind, local, bytes: file?.bytes ?? null, sha256: file?.sha256 ?? null, usedBy: [candidate.key],
        mappedAssetId: entry?.assetId ?? null, mappingVerified: entry ? local ? 'local-source-hash-only' : 'remote-unverified' : null,
        uploadDeclaration: file ? UploadMetadataSchema.parse({ kind, originalName: basename(source), expectedMime: mime, expectedBytes: file.bytes, expectedSha256: file.sha256 }) : null })
    }
    if (!entry) candidate.blockers.push(`需要真实上传资产映射：${source}`)
    if (entry && !local) candidate.notes.push(`远端原图未获取，映射的 SHA-256 由操作者提供，本工具未验证：${source}`)
    return entry?.assetId
  }
  const candidate = (key: string, target: Candidate['target'], sources: string[]): Candidate => {
    const result: Candidate = { key, target, sources, state: 'blocked', draft: null, requiredAssets: [], sourceDate: null, blockers: [], notes: [] }
    candidates.push(result); return result
  }
  const complete = (entry: Candidate, draft: () => Draft) => { if (!entry.blockers.length) { entry.draft = draft(); entry.state = 'ready-draft' } }
  const app = await text('src/App.vue'), defaults = extractSiteDefaults(await text('src/data/site.js'))
  const statement = [...app.matchAll(/<p class="hero-statement">([\s\S]*?)<\/p>/gu)]
  check(statement.length === 1 && !statement[0]![1]!.includes('<'), 'Cannot extract unique plain hero intro')
  const imageFor = (path: string): { source: string; alt: string } => {
    const matches = [...app.matchAll(/<img\s+[^>]*>/gu)].filter(match => match[0].includes(`src="/${path}"`))
    check(matches.length === 1, `Expected one referenced original image: ${path}`)
    const alt = /\balt="([^"]+)"/u.exec(matches[0]![0]); check(alt, `Original image lacks alt: ${path}`)
    return { source: path, alt: decodeEntities(alt[1]!) }
  }
  const about = convertLegacyAbout(await text('content/about.md'))
  const settings = candidate('legacy-site-settings', 'siteSettings', ['src/App.vue', 'src/data/site.js', 'content/about.md'])
  const avatar = imageFor('content/visuals/field-portrait.webp')
  const avatarAssetId = requireAsset(avatar.source, 'image', settings)
  settings.notes.push('heroTitle 使用用户已确定的 V3 原文；intro、about、GitHub 链接来自原仓库。', '保留文字及链接；HTML 样式和容器不迁入，blockquote 转为段落。原始 NBSP 缩进保留。', 'siteTitle、navigation、themePreference 等无旧字段一一映射的值采用共享契约默认值；不导入旧备案号。')
  complete(settings, () => SiteSettingsSchema.parse({ intro: decodeEntities(statement[0]![1]!).trim(), about, avatarAssetId,
    socialLinks: [{ id: 'github', label: 'GitHub', url: defaults.githubProfile }] }))

  const fitness = candidate('legacy-fitness-settings', 'fitnessSettings', ['content/interests/fitness.md'])
  const fitnessIntro = parseLegacyMarkdown(await text('content/interests/fitness.md'))
  check(fitnessIntro.every(part => part.type === 'paragraph' || part.type === 'quote'), 'Fitness intro contains unsupported structured content')
  fitness.notes.push('明确不迁入 App.vue 中 2022-10-18 的旧硬编码日期；用户要求真实起始日期待提供。', '保留原文字；Markdown 引用样式转为纯文本。')
  complete(fitness, () => FitnessSettingsDraftSchema.parse({ startDate: null, intro: fitnessIntro.map(part => part.text).join('\n\n') }))

  const qq = candidate('legacy-default-provider-playlist', 'playlist', ['src/data/site.js'])
  check(defaults.music.sourceType === 'playlist', 'Legacy music source is not a playlist')
  qq.notes.push('仅提取已检入的配置默认值；import.meta.env 可覆盖，不能据此断言线上当前配置。', '不请求 QQ，不虚构曲目；后续需核对实际音乐服务兼容性和曲目可用性。')
  complete(qq, () => PlaylistDraftSchema.parse({ name: defaults.music.name, source: defaults.music.source, sourceId: defaults.music.sourceId, isDefault: true, tracks: [] }))

  const localPlaylists = LegacyPlaylistsSchema.parse(await json('content/music/local_playlists.json'))
  const tracksByFile = new Map<string, z.infer<typeof LegacyTrackSchema>[]>()
  let localTrackReferences = 0
  for (const [index, playlist] of localPlaylists.entries()) {
    const path = normalizeSource(playlist.file), tracks = z.array(LegacyTrackSchema).parse(await json(path))
    tracksByFile.set(path, tracks); localTrackReferences += tracks.length
    const item = candidate(technicalId('legacy-playlist', playlist.id), 'playlist', ['content/music/local_playlists.json', path])
    const mappedTracks = tracks.map((track, trackIndex) => ({ id: technicalId('legacy-track', `${path}:${trackIndex}:${track.url}`), title: track.name, artist: track.artist,
      assetId: requireAsset(track.url, 'audio', item), coverAssetId: requireAsset(track.cover, 'image', item), sortOrder: trackIndex }))
    complete(item, () => PlaylistDraftSchema.parse({ name: playlist.name, source: 'local', tracks: mappedTracks, sortOrder: index + 1 }))
  }
  const fallback = z.array(LegacyTrackSchema).parse(await json('content/music/music.json'))
  const identical = [...tracksByFile.entries()].filter(([, tracks]) => JSON.stringify(tracks) === JSON.stringify(fallback)).map(([path]) => path)
  const aliases = [{ source: 'content/music/music.json', equivalentTo: identical, explanation: identical.length ? '与列出的本地歌单曲目逐项相同，保留来源别名，不重复创建歌单。' : '无完全相同的已命名歌单；未推断名称，不自动创建。' }]

  const articles = LegacyArticlesSchema.parse(await json('content/blog/manifest.json'))
  for (const [index, article] of articles.entries()) {
    const path = normalizeSource(article.filePath), source = await text(path)
    const item = candidate(technicalId('legacy-article', String(article.id)), 'creation', ['content/blog/manifest.json', path])
    if (article.date) item.sourceDate = { value: article.date, source: 'content/blog/manifest.json', pointer: `/${index}/date` }
    item.notes.push('保留 manifest 标题与正文标题各自原文。旧日期仅作来源元数据；V3 publishedAt 只能由真实发布操作产生。', 'slug 使用原 Markdown 文件名；featured 默认 false。')
    let parts: MarkdownPart[]
    try { parts = parseLegacyMarkdown(source) } catch (error) { item.blockers.push(error instanceof Error ? error.message : 'Markdown conversion failed'); continue }
    const blocks: ContentBlock[] = []
    for (const [partIndex, part] of parts.entries()) {
      const id = technicalId('legacy-block', `${path}:${partIndex}`)
      if (part.type === 'image') {
        const assetId = requireAsset(part.source!, 'image', item)
        if (assetId) blocks.push({ id, type: 'image', assetId, alt: part.text, variantRole: 'content' })
      } else if (part.type === 'quote') blocks.push({ id, type: 'quote', text: part.text })
      else blocks.push({ id, type: 'richtext', document: { type: 'doc', content: [part.type === 'heading'
        ? { type: 'heading', attrs: { level: part.level! }, content: [{ type: 'text', text: part.text }] }
        : { type: 'paragraph', content: [{ type: 'text', text: part.text }] }] } })
    }
    complete(item, () => CreationDraftSchema.parse({ kind: 'article', title: article.title, slug: basename(path, '.md'), tags: article.category ? [article.category] : [], blocks, sortOrder: index }))
  }

  const photo = imageFor('content/recent/photography-cover.webp')
  const photoCard = /<article class="recent-card recent-card--photography">([\s\S]*?)<\/article>/u.exec(app)
  const albumTitle = photoCard && /<strong>([^<]+)<\/strong>/u.exec(photoCard[1]!); check(albumTitle, 'Photography card title missing')
  const photoText = parseLegacyMarkdown(await text('content/interests/photography.md'))
  check(photoText.every(part => part.type === 'paragraph' || part.type === 'quote'), 'Photography description contains unsupported content')
  const album = candidate('legacy-photography', 'album', ['src/App.vue', 'content/interests/photography.md'])
  const photoAssetId = requireAsset(photo.source, 'image', album)
  album.notes.push('仅把当前页面明确引用的原摄影封面列入相册草稿；拍摄日期未知保持 null，照片 status=draft。', '相册标题取原摄影卡片“光隅”；slug guang-yu 是技术路由名，发布前可编辑。')
  complete(album, () => AlbumDraftSchema.parse({ title: decodeEntities(albumTitle[1]!), slug: 'guang-yu', description: photoText.map(part => part.text).join('\n\n'), coverAssetId: photoAssetId,
    photos: [{ id: 'legacy-photography-cover', assetId: photoAssetId, alt: photo.alt, photoDate: null, status: 'draft' }] }))

  const remaining = sourcePaths.filter(path => !consumed.has(path))
  const unconverted: MigrationManifest['unconverted'] = []
  const group = (prefixes: string[], reason: string) => {
    const sources = remaining.filter(path => prefixes.some(prefix => path.startsWith(prefix)))
    if (sources.length) { unconverted.push({ sources, reason }); sources.forEach(path => consumed.add(path)) }
  }
  group(['content/Photos/'], '3 张无关联、标题或拍摄日期依据的旧图片，不推断为摄影或健身条目；需要用户指定分类、标题/alt、必要日期。')
  group(['content/recent/fitness-'], '健身原照保留在源文件；无确认的 entryDate，不创建不完整 FitnessEntry；不修改身体形态。')
  group(['content/resume/', 'content/growth.json'], '旧履历、项目/科研描述、成长时间线与进度值原样留档。本工具不重新验证研究成果，也不把旧进度值变为当前统计；需逐条编辑审阅后再迁移。')
  group(['content/bookshelf', 'content/game/', 'content/interests/'], '书架、游戏素材及其余兴趣模块不属于本次可靠自动转换子集；包含旧富媒体/iframe 的内容需人工转换为受控 V3 内容块。')
  group(['content/visuals/', 'content/recent/photography-'], '原页面当前使用 WEBP；其 PNG/JPG 同名伴随原件保留并记录哈希，不推定为同一上传资产，也不自动替换当前图。')
  group(['content/fonts/', 'content/icon/', 'content/social/', 'content/footer-links.json'], '字体、图标、二维码与含旧图标代码的页脚链接属于站点静态资源/配置，未转换为内容；不迁入原始 SVG/HTML。')
  const leftover = remaining.filter(path => !consumed.has(path))
  if (leftover.length) unconverted.push({ sources: leftover, reason: '尚无已实现的严格转换规则；保留原件并列入人工审阅。' })
  if (!identical.length) unconverted.push({ sources: ['content/music/music.json'], reason: '回退曲目与已命名本地歌单不完全相同，需决定歌单归属；没有自动丢弃或合并。' })
  // Rehash every source after reading, so an editor writing during this run cannot silently produce a mixed snapshot.
  for (const file of sourceFiles) check(await hashFile(await checkedPath(root, file.path)) === file.sha256, `Source changed during inventory: ${file.path}`)
  const checkoutHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  let publicContentExists = false
  try { publicContentExists = (await lstat(resolve(root, 'public/content'))).isDirectory() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const mediaList = [...media.values()].sort((a, b) => a.source.localeCompare(b.source))
  return {
    schemaVersion: 1, audit: { generatedAt: new Date().toISOString(), checkoutHead, sourceFiles, originalsUnchanged: true, publicContentExists },
    policy: { writesRemote: false, publishes: false, mediaBytesCopied: false, fitnessStartDate: null, assetReadinessVerifiedRemotely: false },
    counts: { candidates: candidates.length, readyDrafts: candidates.filter(item => item.state === 'ready-draft').length,
      blockedCandidates: candidates.filter(item => item.state === 'blocked').length, articles: articles.length, localPlaylists: localPlaylists.length,
      uniqueLocalAudio: mediaList.filter(item => item.local && item.kind === 'audio').length, localTrackReferences, fallbackTrackReferences: fallback.length,
      matchedFallbackPlaylists: identical.length, referencedPhotography: 1, unclassifiedPhotos: remaining.filter(path => path.startsWith('content/Photos/')).length,
      requiredMediaSources: mediaList.length, requiredLocalBytes: mediaList.reduce((sum, item) => sum + (item.bytes ?? 0), 0) },
    candidates, media: mediaList, aliases, unconverted, unusedMappings: mapping.assets.filter(item => !media.has(item.source)).map(item => item.source),
  }
}

function summary(manifest: MigrationManifest): string {
  return ['# 旧内容私有迁移清单', '', `清单生成时间（不是内容日期）：${manifest.audit.generatedAt}`, `完整仓库 HEAD：${manifest.audit.checkoutHead}`, '',
    `源文件 ${manifest.audit.sourceFiles.length} 个；二次 SHA-256 核验一致。`, `候选 ${manifest.counts.candidates} 项：可审阅完整草稿 ${manifest.counts.readyDrafts}，阻塞 ${manifest.counts.blockedCandidates}。`,
    'ready-draft 仅表示共享契约校验成功及映射已提供；不表示资产在远端 ready、内容已保存、已发布或版权已核实。', '',
    ...manifest.candidates.flatMap(item => [`## ${item.key} — ${item.state}`, '', `目标：${item.target}；来源：${item.sources.join(', ')}`, ...(item.sourceDate ? [`旧日期仅作来源：${item.sourceDate.value}（${item.sourceDate.source}${item.sourceDate.pointer}）`] : []),
      ...item.blockers.map(value => `- 阻塞：${value}`), ...item.notes.map(value => `- 说明：${value}`), '']),
    '## 未自动转换', '', ...manifest.unconverted.flatMap(item => [`- ${item.sources.join(', ')}：${item.reason}`]), '',
    'mapping.template.json 是空输入模板；media-requirements.json 列出实际来源与 SHA-256。不要填写示例资产 ID。',
    '源文件保持原样。没有远端请求、媒体复制、数据库写入或发布。', ''].join('\n')
}

export async function writeLegacyMigration(mappingPath?: string): Promise<{ output: string; manifest: MigrationManifest }> {
  // Fixed destination: no user-controlled --out and no source path override on the CLI.
  const manifest = await buildLegacyMigration(REPO_ROOT, mappingPath ? JSON.parse(await readFile(mappingPath, 'utf8')) : undefined)
  const ignored = execFileSync('git', ['check-ignore', '--no-index', '.private-build/migration/inventory.json'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true }).trim()
  check(ignored === '.private-build/migration/inventory.json', 'Private migration output is not gitignored')
  for (const directory of ['.private-build', '.private-build/migration']) {
    try { await mkdir(resolve(REPO_ROOT, directory), { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    check((await lstat(await checkedPath(REPO_ROOT, directory))).isDirectory(), 'Private output is not a real directory')
  }
  const output = await mkdtemp(resolve(REPO_ROOT, '.private-build/migration/run-'))
  for (const [name, value] of [
    ['manifest.json', JSON.stringify(manifest, null, 2)],
    ['mapping.template.json', JSON.stringify({ schemaVersion: 1, assets: [] }, null, 2)],
    ['media-requirements.json', JSON.stringify(manifest.media, null, 2)], ['REVIEW.md', summary(manifest)],
  ] as const) await writeFile(resolve(output, name), `${value}\n`, { flag: 'wx', mode: 0o600 })
  return { output, manifest }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('Local-only: tsx scripts/v3/migrate-legacy.ts [--mapping <private-json-path>]\nOutput: .private-build/migration/run-*/ (never remote, upload, seed or publish)'); return
  }
  check(args.length === 0 || (args.length === 2 && args[0] === '--mapping' && args[1]), 'Usage: migrate-legacy.ts [--mapping <private-json-path>]')
  const { output, manifest } = await writeLegacyMigration(args[1] ? resolve(args[1]) : undefined)
  console.log(JSON.stringify({ output, counts: manifest.counts, sourceFiles: manifest.audit.sourceFiles.length, originalsUnchanged: manifest.audit.originalsUnchanged }, null, 2))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Migration inventory failed'); process.exitCode = 1 })
}
