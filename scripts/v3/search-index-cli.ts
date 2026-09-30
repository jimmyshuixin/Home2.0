import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildSearchIndex } from './search-index';

const snapshot = process.env.XVYIN_SNAPSHOT_PATH
  ? JSON.parse(await readFile(resolve(process.env.XVYIN_SNAPSHOT_PATH), 'utf8'))
  : { schemaVersion: 1, releaseId: 'unpublished', settings: {}, creations: [], albums: [], fitness: { settings: {}, entries: [] }, playlists: [], assets: [], routeAliases: {} };
const manifest = await buildSearchIndex(resolve(import.meta.dirname, '../../apps/web/.output/public'), snapshot);
console.log(`Search index: ${manifest.documentCount} public documents, release ${manifest.releaseId}.`);
