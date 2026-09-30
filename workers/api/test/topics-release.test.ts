import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { AlbumDraftSchema, CreationDraftSchema, SiteSettingsSchema } from '@xvyin/contracts';
import { Releases, type ReleaseChange, type ReleaseJob } from '../src/releases';
import { Records } from '../src/records';
import { MemoryStore } from '../src/store/memory';
import { publicSnapshot } from '../../../apps/web/lib/build-snapshot';
import { searchRecords } from '../../../scripts/v3/search-index';

const now = Date.UTC(2026, 8, 30), codeSha = 'a'.repeat(40), runId = 'topics-run';
let mf: Miniflare, bucket: R2Bucket, store: MemoryStore, records: Records, releases: Releases;
beforeAll(async () => {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("fixture"); } }', compatibilityDate: '2026-09-11', r2Buckets: ['MEDIA'] }), telemetry: { enabled: false }, cf: false });
  bucket = await mf.getR2Bucket('MEDIA') as unknown as R2Bucket;
});
afterAll(async () => { await mf.dispose(); });
beforeEach(async () => {
  const objects = await bucket.list(); if (objects.objects.length) await bucket.delete(objects.objects.map(item => item.key));
  store = new MemoryStore(); records = new Records(store, () => now); releases = new Releases(store, bucket, () => now, codeSha);
});
async function fixture() {
  const article = await records.save('creations', CreationDraftSchema, { title: 'Public article', slug: 'article', blocks: [{ id: 'quote', type: 'quote', text: 'Published text' }] }, 'admin', 'article');
  const album = await records.save('albums', AlbumDraftSchema, { title: 'Public album', slug: 'album' }, 'admin', 'album');
  await records.save('creations', CreationDraftSchema, { title: 'PRIVATE DRAFT TITLE', slug: 'private-draft' }, 'admin', 'private-draft-id');
  const settings = await records.save('settings', SiteSettingsSchema, { topics: [
    { id: 'topic', slug: 'journey', title: 'Published topic', enabled: true, members: [{ collection: 'albums', id: album.id }, { collection: 'creations', id: 'private-draft-id' }, { collection: 'creations', id: article.id }, { collection: 'albums', id: 'missing-id' }] },
    { id: 'disabled', slug: 'private-topic', title: 'PRIVATE TOPIC TITLE', enabled: false, members: [{ collection: 'creations', id: article.id }] },
    { id: 'empty', slug: 'empty-topic', title: 'PRIVATE EMPTY TITLE', enabled: true, members: [{ collection: 'creations', id: 'private-draft-id' }] },
  ] }, 'admin', 'site');
  const changes: ReleaseChange[] = [ { collection: 'settings', id: 'site', version: settings.version, action: 'publish' }, { collection: 'creations', id: article.id, version: article.version, action: 'publish' }, { collection: 'albums', id: album.id, version: album.version, action: 'publish' } ];
  const job = await releases.create({ changes, expectedReleaseId: null }, 'admin');
  return { job, settings, article, album };
}
async function activateFixture(job: ReleaseJob) {
  await bucket.put('active-release.json', JSON.stringify({ releaseId: job.id, manifestSha256: 'b'.repeat(64), schemaVersion: 1, activatedAt: new Date(now).toISOString(), codeSha, runId }));
}
describe('topic release projection', () => {
  it('freezes only selected public references, independent of change order, without reading private labels', async () => {
    const { job, settings } = await fixture(), snapshot = await releases.snapshot(job.id), serialized = JSON.stringify(snapshot);
    expect(snapshot.settings.topics).toHaveLength(1);
    expect(snapshot.settings.topics![0]!.members).toEqual([{ collection: 'albums', id: 'album' }, { collection: 'creations', id: 'article' }]);
    for (const privateText of ['private-draft-id', 'missing-id', 'PRIVATE', 'private-topic', 'empty-topic']) expect(serialized).not.toContain(privateText);
    expect(publicSnapshot(snapshot).settings.topics).toEqual(snapshot.settings.topics);
    expect(searchRecords(snapshot).records.find(record => record.url === '/topics/journey')?.content).toContain('Public album\nPublic article');
    expect((await store.get<{ draft: unknown }>('settings/site'))!.draft).toEqual(settings.draft);
    await activateFixture(job);
    expect((await releases.changesPage('settings')).items.find(item => item.id === 'site')?.changeKind).toBe('unchanged');
  });
  it('removes a newly hidden member and never incorporates unselected settings changes', async () => {
    const { job, settings, article } = await fixture(); await activateFixture(job);
    await records.save('settings', SiteSettingsSchema, { ...settings.draft, topics: [{ ...settings.draft.topics![0]!, title: 'PRIVATE UNSELECTED TITLE' }] }, 'admin', 'site', settings.version);
    const next = await releases.create({ changes: [{ collection: 'creations', id: article.id, version: article.version, action: 'hide' }], expectedReleaseId: job.id }, 'admin');
    const snapshot = await releases.snapshot(next.id);
    expect(snapshot.settings.topics![0]!).toMatchObject({ title: 'Published topic', members: [{ collection: 'albums', id: 'album' }] });
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE UNSELECTED TITLE');
    expect(JSON.stringify(snapshot.settings.topics)).not.toContain('article');
    expect((await releases.snapshot(job.id)).settings.topics![0]!.members).toHaveLength(2);
  });
  it('requires topic pages in the registered build and preserves topics in code-only rebuilds', async () => {
    const { job } = await fixture(); await releases.claim(job.id, runId, codeSha);
    const routes = ['/', '/about/', '/creations/', '/photography/', '/fitness/', '/guestbook/', '/contact/', '/creations/article/', '/photography/album/'];
    const files = (paths: string[]) => ({ files: paths.map(path => ({ path: `${path}index.html`, sha256: 'c'.repeat(64), bytes: 200, contentType: 'text/html; charset=utf-8' })) });
    await expect(releases.registerManifest(job.id, runId, files(routes))).rejects.toMatchObject({ code: 'BUILD_ROUTE_MISSING' });
    await expect(releases.registerManifest(job.id, runId, files([...routes, '/topics/', '/topics/journey/']))).resolves.toHaveProperty('releaseId', job.id);
    await activateFixture(job);
    const rebuilt = await releases.create({ changes: [], rebuildPublished: true, expectedReleaseId: job.id }, 'admin');
    expect((await releases.snapshot(rebuilt.id)).settings).toEqual((await releases.snapshot(job.id)).settings);
  });
  it('keeps renamed topic links and removes their aliases when the topic is hidden', async () => {
    const { job, settings } = await fixture(); await activateFixture(job);
    const renamed = await records.save('settings', SiteSettingsSchema, { topics: [{ ...settings.draft.topics![0]!, slug: 'new-journey' }] }, 'admin', 'site', settings.version);
    const next = await releases.create({ changes: [{ collection: 'settings', id: 'site', version: renamed.version, action: 'publish' }], expectedReleaseId: job.id }, 'admin');
    expect((await releases.snapshot(next.id)).routeAliases).toEqual({ '/topics/journey': '/topics/new-journey' });
    await activateFixture(next);
    const hidden = await records.save('settings', SiteSettingsSchema, { topics: [{ ...renamed.draft.topics![0]!, enabled: false }] }, 'admin', 'site', renamed.version);
    const last = await releases.create({ changes: [{ collection: 'settings', id: 'site', version: hidden.version, action: 'publish' }], expectedReleaseId: next.id }, 'admin');
    expect((await releases.snapshot(last.id)).settings.topics).toEqual([]);
    expect((await releases.snapshot(last.id)).routeAliases).toEqual({});
  });
});
