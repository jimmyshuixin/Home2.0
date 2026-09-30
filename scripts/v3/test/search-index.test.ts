import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { close } from 'pagefind';
import { buildSearchIndex, searchRecords, SearchIndexError, verifySearchIndex } from '../search-index';

const at = '2026-09-30T00:00:00.000Z';
export function searchSnapshot() {
  return {
    schemaVersion: 1, releaseId: 'search-release-one',
    settings: { siteTitle: '虚宁的纸墨日常', intro: '这里收录公开的创作与摄影。', about: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '在文字里保存生活的片刻。' }] },
    ] } },
    creations: [{ id: 'published-creation', revisionId: 'published-revision', publishedAt: at,
      title: '河岸随记', slug: 'river-notes', summary: '黄昏散步', formats: ['text'], tags: ['散文'], blocks: [
        { id: 'words', type: 'richtext', document: { type: 'doc', content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '落日与江风' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '芦苇荡深处有一只白鹭。' }, { type: 'hardBreak' }, { type: 'text', text: '江边的晚霞映着小船。', marks: [{ type: 'link', attrs: { href: 'https://example.com/DO_NOT_INDEX_LINK' } }] }] },
          { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '桥下的水声' }] }] }] },
        ] } },
        { id: 'quote', type: 'quote', text: '把日常留给远方。', attribution: '公开引文', sourceUrl: 'https://example.com/DO_NOT_INDEX_SOURCE' },
        { id: 'code', type: 'code', language: 'html', code: '<button>字面代码</button>' },
      ] }],
    albums: [{ id: 'published-album', revisionId: 'album-revision', publishedAt: at, title: '山间', slug: 'mountains', description: '晨雾笼罩青山',
      photos: [{ id: 'public-photo', assetId: 'public-image', alt: '云海之间的一棵松树', caption: '松针挂着露珠', status: 'published',
        location: { latitude: 30.123456, longitude: 120.654321, precision: 'exact', label: 'DO_NOT_INDEX_LOCATION' } }] }],
    fitness: { settings: { intro: '慢慢练习，慢慢进步' }, entries: [{ id: 'fitness-entry', revisionId: 'fitness-revision', publishedAt: at,
      title: '早晨训练', caption: '今天完成了引体向上。', entryDate: '2026-09-29', photos: [], tags: ['力量'] }] },
    playlists: [], assets: [], routeAliases: { '/DO_NOT_INDEX_ALIAS': '/about' },
  };
}
const temporary: string[] = [];
async function outputDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'xvyin-search-test-'));
  temporary.push(root);
  const output = join(root, 'public');
  await mkdir(output);
  return output;
}
afterEach(async () => {
  for (const root of temporary.splice(0)) {
    expect(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/')).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});
afterAll(async () => { await close(); });

describe('release-scoped public text projection', () => {
  it('indexes body, nested rich text and published photo captions without unrelated/private metadata', () => {
    const projected = searchRecords(searchSnapshot());
    expect(projected.records.map(record => record.url)).toEqual(['/about', '/creations/river-notes', '/fitness', '/photography/mountains']);
    const body = projected.records.find(record => record.meta.category === 'creation')!;
    expect(body.content).toContain('芦苇荡深处有一只白鹭。');
    expect(body.content).toContain('桥下的水声');
    expect(body.content).toContain('字面代码');
    expect(projected.records.find(record => record.meta.category === 'photography')?.content).toContain('松针挂着露珠');
    const json = JSON.stringify(projected);
    expect(json).not.toContain('DO_NOT_INDEX');
    expect(json).not.toContain('30.123456');
    expect(json).not.toContain('120.654321');
    expect(json).not.toContain('public-image');
    expect(projected.records.every(record => record.language === 'zh')).toBe(true);
  });

  it('rejects raw drafts, hidden photos and private fields instead of silently indexing them', () => {
    const source = searchSnapshot();
    for (const status of ['draft', 'hidden']) {
      const value = structuredClone(source);
      value.albums[0]!.photos[0]!.status = status;
      expect(() => searchRecords(value)).toThrow();
    }
    expect(() => searchRecords({ ...source, drafts: [{ title: 'PRIVATE_DRAFT_SENTINEL' }] })).toThrow();
    const badCreation = { ...source.creations[0], status: 'hidden' };
    expect(() => searchRecords({ ...source, creations: [badCreation] })).toThrow();
    const badPhoto = { ...source.albums[0]!.photos[0], map: { coordinates: { latitude: 20, longitude: 30 } } };
    expect(() => searchRecords({ ...source, albums: [{ ...source.albums[0], photos: [badPhoto] }] })).toThrow();
  });

  it('uses deterministic public-text hashes and rejects duplicate routes', () => {
    const source = searchSnapshot(), first = searchRecords(source);
    const shuffled = { ...source, creations: [...source.creations].reverse(), albums: [...source.albums].reverse() };
    expect(searchRecords(shuffled).projectionSha256).toBe(first.projectionSha256);
    const changed = structuredClone(source);
    changed.creations[0]!.summary += '新的一天';
    expect(searchRecords(changed).projectionSha256).not.toBe(first.projectionSha256);
    expect(() => searchRecords({ ...source, creations: [source.creations[0], source.creations[0]] })).toThrow('duplicate');
    expect(() => searchRecords({ ...source, creations: [source.creations[0], source.creations[0]] })).toThrow(SearchIndexError);
  });
});

describe('real Pagefind native indexing and immutable output', () => {
  it('builds Chinese assets from projected records and verifies the complete manifest', async () => {
    const output = await outputDirectory(), source = searchSnapshot();
    const result = await buildSearchIndex(output, source);
    expect(result.documentCount).toBe(4);
    expect(result.files.some(file => file.path === 'pagefind.js')).toBe(true);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(await verifySearchIndex(output, source)).toEqual(result);
    expect(await readdir(output)).toEqual(['search-index']);
    // Check the real serialized fragments, not a mock of Pagefind's API.
    const fragments = result.files.filter(file => file.path.endsWith('.pf_fragment'));
    expect(fragments).toHaveLength(4);
    const decoded: string[] = [];
    for (const file of fragments) {
      const bytes = await readFile(join(output, 'search-index', source.releaseId, file.path));
      decoded.push(Buffer.from(gunzipSync(bytes)).toString('utf8'));
    }
    // The real Chinese segmenter inserts zero-width word separators in fragments.
    expect(decoded.join(' ').replace(/\u200b/gu, '')).toContain('芦苇荡');
    expect(decoded.join(' ')).toContain('松针');
    expect(decoded.join(' ')).not.toContain('DO_NOT_INDEX');
    expect(decoded.join(' ')).not.toContain('30.123456');
  });

  it('fails closed on tampering, mismatched snapshots, missing files and unexpected files', async () => {
    const output = await outputDirectory(), source = searchSnapshot();
    const built = await buildSearchIndex(output, source);
    const root = join(output, 'search-index', source.releaseId);
    const changed = structuredClone(source);
    changed.creations[0]!.summary = '另一个版本';
    await expect(verifySearchIndex(output, changed)).rejects.toThrow('does not match');
    const entry = join(root, 'pagefind.js'), bytes = await readFile(entry);
    await writeFile(entry, 'tampered');
    await expect(verifySearchIndex(output, source)).rejects.toThrow('changed');
    await writeFile(entry, bytes);
    const added = join(root, 'unlisted.json');
    await writeFile(added, '{}');
    await expect(verifySearchIndex(output, source)).rejects.toThrow('inventory');
    await rm(added);
    const target = join(root, built.files[0]!.path);
    await rm(target);
    await expect(verifySearchIndex(output, source)).rejects.toThrow('inventory');
  });

  it('never overwrites a prior bundle or follows an output-parent junction', async () => {
    const output = await outputDirectory(), source = searchSnapshot();
    await buildSearchIndex(output, source);
    await expect(buildSearchIndex(output, source)).rejects.toThrow('already exists');
    const other = await outputDirectory();
    await symlink(join(output, 'search-index'), join(other, 'search-index'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(buildSearchIndex(other, source)).rejects.toThrow('already exists');
    await expect(verifySearchIndex(other, source)).rejects.toThrow('link');
  });

  it('validates the snapshot before creating any search output', async () => {
    const output = await outputDirectory();
    await expect(buildSearchIndex(output, { ...searchSnapshot(), releaseId: '../private' })).rejects.toThrow();
    expect(await readdir(output)).toEqual([]);
  });

  it('classifies missing bundles and malformed manifests as deterministic integrity failures', async () => {
    const output = await outputDirectory(), source = searchSnapshot();
    await expect(verifySearchIndex(output, source)).rejects.toBeInstanceOf(SearchIndexError);
    await buildSearchIndex(output, source);
    await writeFile(join(output, 'search-index', source.releaseId, 'xvyin-search.json'), '{PRIVATE_SENTINEL');
    await expect(verifySearchIndex(output, source)).rejects.toThrow('search manifest is not valid JSON');
    await expect(verifySearchIndex(output, source)).rejects.toBeInstanceOf(SearchIndexError);
    await expect(verifySearchIndex(output, source)).rejects.not.toThrow('PRIVATE_SENTINEL');
    await writeFile(join(output, 'search-index', source.releaseId, 'xvyin-search.json'), 'null');
    await expect(verifySearchIndex(output, source)).rejects.toBeInstanceOf(SearchIndexError);
    await rm(join(output, 'search-index', source.releaseId, 'xvyin-search.json'));
    await expect(verifySearchIndex(output, source)).rejects.toBeInstanceOf(SearchIndexError);
  });
});
