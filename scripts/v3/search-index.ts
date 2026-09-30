import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ContentBlock, RichTextDocument } from '@xvyin/contracts';
import { PublicSnapshotSchema } from '../../apps/web/lib/build-snapshot';
import { SEARCH_CATEGORIES, searchBundlePath, type SearchCategory } from '../../apps/web/lib/search-shared';

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 1024;
const MAX_RECORDS = 2000;
const MARKER = 'xvyin-search.json';
const SCHEMA_VERSION = 1;
export interface SearchRecord {
  url: string; content: string; language: 'zh';
  meta: { title: string; category: SearchCategory; publishedAt: string };
  filters: { category: SearchCategory[] };
}
interface SearchFile { path: string; bytes: number; sha256: string }
export interface SearchIndexManifest {
  schemaVersion: 1; releaseId: string; projectionSha256: string; documentCount: number;
  files: SearchFile[]; totalBytes: number;
}
export class SearchIndexError extends Error {
  readonly code = 'SEARCH_INDEX_INVALID';
  constructor(message: string) { super(`SEARCH_INDEX_INVALID: ${message}`); this.name = 'SearchIndexError'; }
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new SearchIndexError(message);
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const words = (values: Array<string | undefined>) => values.filter(Boolean).join('\n');
function richText(document: RichTextDocument): string {
  function nodeText(node: unknown): string {
    if (!node || typeof node !== 'object') return '';
    const value = node as { type?: string; text?: string; content?: unknown[] };
    if (value.type === 'text') return value.text || '';
    if (value.type === 'hardBreak') return '\n';
    const inline = value.type === 'paragraph' || value.type === 'heading';
    return Array.isArray(value.content) ? value.content.map(nodeText).join(inline ? '' : '\n') : '';
  }
  return nodeText(document);
}
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'richtext': return richText(block.document);
    case 'image': return words([block.alt, block.caption]);
    case 'compare': return words([block.before.label, block.before.alt, block.after.label, block.after.alt, block.caption]);
    case 'gallery': return block.items.map(photo => words([photo.alt, photo.caption])).join('\n');
    case 'audio': return words([block.title, block.artist, block.transcript]);
    case 'video': return block.transcript || '';
    case 'quote': return words([block.text, block.attribution]);
    case 'code': return words([block.filename, block.language, block.code]);
    case 'file': return words([block.label, block.description]);
  }
}

/** Only an already projected public release snapshot may enter the search index. */
export function searchRecords(input: unknown): { releaseId: string; records: SearchRecord[]; projectionSha256: string } {
  const snapshot = PublicSnapshotSchema.parse(input);
  searchBundlePath(snapshot.releaseId);
  const records: SearchRecord[] = [];
  const add = (url: string, title: string, content: string, category: SearchCategory, publishedAt = '') => {
    records.push({ url, content: words([title, SEARCH_CATEGORIES[category], content]), language: 'zh',
      meta: { title, category, publishedAt }, filters: { category: [category] } });
  };
  add('/about', `关于 · ${snapshot.settings.siteTitle}`, words([snapshot.settings.intro, richText(snapshot.settings.about)]), 'about');
  if (snapshot.settings.now) add('/now', '近况 · 最近在做的事', snapshot.settings.now.text, 'now', snapshot.settings.now.updatedAt || '');
  for (const entry of snapshot.creations) {
    add(`/creations/${entry.slug}`, entry.title, words([entry.summary, entry.tags.join(' '), ...entry.blocks.map(blockText)]), entry.kind === 'note' ? 'note' : 'creation', entry.publishedAt);
  }
  for (const album of snapshot.albums) {
    // No asset properties, coordinates, EXIF, map settings or source URLs are indexed.
    add(`/photography/${album.slug}`, album.title,
      words([album.description, ...album.photos.map(photo => words([photo.alt, photo.caption]))]), 'photography', album.publishedAt);
  }
  for (const topic of snapshot.settings.topics || []) {
    add(`/topics/${topic.slug}`, topic.title, words([topic.intro, ...topic.members.map(member =>
      (member.collection === 'creations' ? snapshot.creations : snapshot.albums).find(item => item.id === member.id)!.title)]), 'topic');
  }
  if (snapshot.fitness.settings.intro || snapshot.fitness.entries.length) {
    add('/fitness', '健身 · 日常记录', words([snapshot.fitness.settings.intro,
      ...snapshot.fitness.entries.map(entry => words([entry.title, entry.caption, entry.tags.join(' '), entry.entryDate,
        ...entry.photos.map(photo => words([photo.alt, photo.caption]))]))]), 'fitness');
  }
  records.sort((left, right) => left.url.localeCompare(right.url, 'en'));
  assert(records.length <= MAX_RECORDS, 'too many published documents');
  assert(new Set(records.map(record => record.url)).size === records.length, 'duplicate public search route');
  const serialized = JSON.stringify(records);
  assert(Buffer.byteLength(serialized, 'utf8') <= MAX_INPUT_BYTES, 'published text exceeds search budget');
  return { releaseId: snapshot.releaseId, records, projectionSha256: hash(serialized) };
}
function bundleFilePath(value: unknown): value is string {
  return typeof value === 'string' && value.length < 400 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    && !value.split('/').some(part => !part || part.startsWith('.'))
    && !/\.(?:map|ts|tsx|vue|env|log|html)$/iu.test(value) && value !== MARKER;
}
function contained(root: string, path: string): boolean {
  const local = relative(root, path);
  return Boolean(local) && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`);
}
async function readTree(root: string): Promise<string[]> {
  const paths: string[] = [];
  let visited = 0;
  async function visit(directory: string) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      assert(++visited <= MAX_FILES * 2, 'search output has too many directory entries');
      const path = resolve(directory, item.name);
      assert(contained(root, path) && !item.isSymbolicLink(), 'search output contains a link or unsafe path');
      if (item.isDirectory()) await visit(path);
      else { assert(item.isFile(), 'search output contains a special file'); paths.push(relative(root, path).split(sep).join('/')); }
      assert(paths.length <= MAX_FILES + 1, 'search output has too many files');
    }
  }
  await visit(root);
  return paths.sort();
}

/** Call after static generation, before buildManifest and copying immutable output. */
export async function buildSearchIndex(directory: string, input: unknown): Promise<SearchIndexManifest> {
  const { releaseId, records, projectionSha256 } = searchRecords(input);
  const root = await realpath(directory), parent = resolve(root, 'search-index');
  const bundle = resolve(root, searchBundlePath(releaseId).slice(1));
  assert(contained(root, bundle), 'search directory escaped the static output');
  try { await lstat(parent); assert(false, 'search output already exists; regenerate or verify it'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const stage = resolve(dirname(root), `.search-index-${randomUUID()}`);
  assert(contained(dirname(root), stage), 'invalid staging directory');
  const pagefind = await import('pagefind');
  const created = await pagefind.createIndex({ forceLanguage: 'zh', writePlayground: false, verbose: false });
  assert(!created.errors?.length && created.index, 'Pagefind could not create the Chinese index');
  const index = created.index;
  try {
    for (const record of records) {
      const result = await index.addCustomRecord(record);
      assert(!result.errors?.length, 'Pagefind rejected a published document');
    }
    const generated = await index.getFiles();
    assert(!generated.errors?.length && generated.files?.length && generated.files.length <= MAX_FILES, 'Pagefind produced no valid files');
    assert(generated.files.some(file => file.path === 'pagefind.js'), 'Pagefind entry module is missing');
    assert(new Set(generated.files.map(file => file.path)).size === generated.files.length, 'Pagefind produced duplicate files');
    const files: SearchFile[] = [];
    let totalBytes = 0;
    // Validate every generated path and size before writing any output.
    for (const file of generated.files) {
      assert(bundleFilePath(file.path), 'Pagefind produced an unsupported path');
      assert(file.content.byteLength > 0 && file.content.byteLength <= MAX_FILE_BYTES, 'search file exceeds size budget');
      totalBytes += file.content.byteLength;
      assert(totalBytes <= MAX_OUTPUT_BYTES, 'search index exceeds total size budget');
      files.push({ path: file.path, bytes: file.content.byteLength, sha256: hash(file.content) });
    }
    files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    const manifest: SearchIndexManifest = { schemaVersion: SCHEMA_VERSION, releaseId, projectionSha256, documentCount: records.length, files, totalBytes };
    await mkdir(stage, { recursive: false });
    for (const file of generated.files) {
      const output = resolve(stage, file.path);
      assert(contained(stage, output), 'search file escaped the staging directory');
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, file.content, { flag: 'wx' });
    }
    await writeFile(resolve(stage, MARKER), JSON.stringify(manifest), { flag: 'wx' });
    await mkdir(parent, { recursive: false });
    await rename(stage, bundle);
    return manifest;
  } finally {
    try { await index.deleteIndex(); }
    finally {
      // The temporary directory was generated under the verified output parent.
      assert(contained(dirname(root), stage) && stage.startsWith(resolve(dirname(root), '.search-index-')), 'unsafe staging cleanup');
      await rm(stage, { recursive: true, force: true });
    }
  }
}

/** Resume may reuse output only when it still matches this public snapshot. */
export async function verifySearchIndex(directory: string, input: unknown): Promise<SearchIndexManifest> {
  try { return await verifySearchIndexFiles(directory, input); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SearchIndexError('search output is incomplete');
    throw error;
  }
}
async function verifySearchIndexFiles(directory: string, input: unknown): Promise<SearchIndexManifest> {
  const expected = searchRecords(input), root = await realpath(directory);
  const bundle = resolve(root, searchBundlePath(expected.releaseId).slice(1));
  let info;
  try { info = await lstat(bundle); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SearchIndexError('search bundle is missing'); throw error; }
  assert(info.isDirectory() && !info.isSymbolicLink(), 'search bundle is missing or is a link');
  assert(await realpath(bundle) === bundle, 'search bundle traverses a link');
  const markerPath = resolve(bundle, MARKER), markerInfo = await lstat(markerPath);
  assert(markerInfo.isFile() && !markerInfo.isSymbolicLink() && markerInfo.size <= 512 * 1024, 'invalid search manifest');
  let manifest: SearchIndexManifest;
  try { manifest = JSON.parse(await readFile(markerPath, 'utf8')) as SearchIndexManifest; }
  catch (error) { if (error instanceof SyntaxError) throw new SearchIndexError('search manifest is not valid JSON'); throw error; }
  assert(manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest), 'invalid search manifest shape');
  assert(manifest.schemaVersion === SCHEMA_VERSION && manifest.releaseId === expected.releaseId
    && manifest.projectionSha256 === expected.projectionSha256 && manifest.documentCount === expected.records.length, 'search snapshot does not match the release');
  assert(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= MAX_FILES, 'invalid search file inventory');
  assert(manifest.files.every(file => file !== null && typeof file === 'object' && bundleFilePath(file.path)
    && Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= MAX_FILE_BYTES
    && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(file.sha256)), 'invalid search file record');
  const paths = await readTree(bundle), expectedPaths = [...manifest.files.map(file => file.path), MARKER].sort();
  assert(JSON.stringify(paths) === JSON.stringify(expectedPaths), 'search file inventory differs from its manifest');
  assert(manifest.files.some(file => file.path === 'pagefind.js'), 'search entry module is missing');
  let bytes = 0;
  for (const file of manifest.files) {
    assert(bundleFilePath(file.path) && Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= MAX_FILE_BYTES, 'invalid search file record');
    const content = await readFile(resolve(bundle, file.path));
    assert(content.byteLength === file.bytes && hash(content) === file.sha256, 'search output changed after indexing');
    bytes += file.bytes;
    assert(bytes <= MAX_OUTPUT_BYTES, 'search index exceeds total size budget');
  }
  assert(bytes === manifest.totalBytes, 'search byte total differs');
  return manifest;
}
