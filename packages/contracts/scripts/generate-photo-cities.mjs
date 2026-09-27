// Rebuild the checked-in compact gazetteer from the pinned upstream GeoJSON.
// Downloading upstream data is an explicit development step, never a runtime request.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const input = process.argv[2];
if (!input) throw new Error('Usage: node packages/contracts/scripts/generate-photo-cities.mjs <ne_10m_populated_places.geojson>');
const source = fs.readFileSync(input);
const sha256 = createHash('sha256').update(source).digest('hex');
const expected = '9b8e3de09048ef00dfc70357dbb9fa324493f214b5e0ae4daf1aa79a8d10116b';
if (sha256 !== expected) throw new Error(`Unexpected upstream data SHA-256: ${sha256}`);
const data = JSON.parse(source.toString('utf8'));
const rows = [];
for (const feature of data.features) {
  const p = feature.properties;
  const administrative = /^Admin-[01] (?:region )?capital(?: alt)?$/.test(p.FEATURECLA);
  if (!administrative && !(p.FEATURECLA === 'Populated place' && p.POP_MAX >= 50_000)) continue;
  const label = [p.NAME_ZH, p.NAME_EN, p.NAME].find(value => typeof value === 'string' && value.trim())?.trim();
  const [longitude, latitude] = feature.geometry?.coordinates ?? [];
  if (!label || label.length > 150 || feature.geometry.type !== 'Point' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error(`Invalid city ${p.NE_ID}`);
  rows.push([latitude, longitude, label]);
}
rows.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
const generated = `// Generated from Natural Earth 10m populated places v5.1.2 (public domain).\n// See PHOTO-CITY-DATA.md for source, selection, SHA-256 and reproduction.\n// Sorted by latitude, then longitude and label; do not reorder manually.\nexport const PHOTO_CITIES: ReadonlyArray<readonly [latitude: number, longitude: number, label: string]> = [\n${rows.map(row => `  ${JSON.stringify(row)},`).join('\n')}\n];\n`;
const target = fileURLToPath(new URL('../src/photo-city-data.ts', import.meta.url));
fs.writeFileSync(target, generated);
console.log(JSON.stringify({ sourceFeatures: data.features.length, selectedCities: rows.length, generatedBytes: Buffer.byteLength(generated), sourceSha256: sha256, generatedSha256: createHash('sha256').update(generated).digest('hex') }, null, 2));
