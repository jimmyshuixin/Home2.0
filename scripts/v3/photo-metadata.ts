import sax from 'sax';
import { PhotographyMetadataSchema, PhotoCoordinatesSchema, type PhotographyMetadata, type PhotoCoordinates } from '@xvyin/contracts';

type Value = string | number | number[];
type Tags = Map<number, Value>;
type Fields = Map<string, Value[]>;
export interface PhotoMetadata { photography?: PhotographyMetadata; gps?: PhotoCoordinates }
const MAX_BLOCK_BYTES = 1024 * 1024;
const EXIF_TAGS = new Set([0x010f, 0x0110, 0x8769, 0x8825, 0x829a, 0x829d, 0x8827, 0x8830, 0x8831, 0x8832, 0x8833, 0x9003, 0x9011, 0x9201, 0x9202, 0x920a, 0xa405, 0xa433, 0xa434]);

/** Bounded TIFF directories only: no thumbnails, MakerNotes, owner or serial tags. */
function readExif(exif?: Uint8Array): { tags: Tags; gps: Tags } {
  const tags: Tags = new Map(), gps: Tags = new Map();
  if (!exif || exif.byteLength < 8 || exif.byteLength > MAX_BLOCK_BYTES) return { tags, gps };
  try {
    const start = exif[0] === 0x45 && exif[1] === 0x78 && exif[2] === 0x69 && exif[3] === 0x66 && exif[4] === 0 && exif[5] === 0 ? 6 : 0;
    const bytes = exif.subarray(start), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 8) return { tags, gps };
    const little = bytes[0] === 0x49 && bytes[1] === 0x49;
    if ((!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) || view.getUint16(2, little) !== 42) return { tags, gps };
    const u16 = (offset: number) => view.getUint16(offset, little), u32 = (offset: number) => view.getUint32(offset, little);
    const visited = new Set<number>();
    const readDirectory = (offset: number, output: Tags, wanted: Set<number>) => {
      if (!Number.isSafeInteger(offset) || offset < 8 || offset + 2 > bytes.byteLength || visited.has(offset)) return;
      visited.add(offset);
      const count = u16(offset);
      if (count > 512 || offset + 2 + count * 12 > bytes.byteLength) return;
      for (let index = 0; index < count; index++) {
        const entry = offset + 2 + index * 12, tag = u16(entry);
        if (!wanted.has(tag) || output.has(tag)) continue;
        const type = u16(entry + 2), length = u32(entry + 4), unit = ({ 2: 1, 3: 2, 4: 4, 5: 8, 9: 4, 10: 8 } as Record<number, number>)[type];
        if (!unit || !length || length > (type === 2 ? 512 : 32)) continue;
        const size = unit * length, valueAt = size <= 4 ? entry + 8 : u32(entry + 8);
        if (valueAt + size > bytes.byteLength) continue;
        if (type === 2) {
          const value = new TextDecoder().decode(bytes.subarray(valueAt, valueAt + size)).split('\0', 1)[0]!.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
          if (value) output.set(tag, value);
        } else {
          const values: number[] = [];
          for (let part = 0; part < length; part++) {
            const at = valueAt + part * unit;
            if (type === 3) values.push(u16(at));
            else if (type === 4) values.push(u32(at));
            else if (type === 9) values.push(view.getInt32(at, little));
            else {
              const numerator = type === 10 ? view.getInt32(at, little) : u32(at);
              const denominator = type === 10 ? view.getInt32(at + 4, little) : u32(at + 4);
              values.push(denominator ? numerator / denominator : NaN);
            }
          }
          output.set(tag, length === 1 ? values[0]! : values);
        }
      }
    };
    readDirectory(u32(4), tags, EXIF_TAGS);
    const exifDirectory = tags.get(0x8769), gpsDirectory = tags.get(0x8825);
    if (typeof exifDirectory === 'number') readDirectory(exifDirectory, tags, EXIF_TAGS);
    if (typeof gpsDirectory === 'number') readDirectory(gpsDirectory, gps, new Set([1, 2, 3, 4]));
  } catch { /* A broken optional directory must not discard valid sibling fields. */ }
  return { tags, gps };
}

const NS = {
  tiff: 'http://ns.adobe.com/tiff/1.0/', exif: 'http://ns.adobe.com/exif/1.0/',
  exifEX: 'http://cipa.jp/exif/1.0/', aux: 'http://ns.adobe.com/exif/1.0/aux/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
} as const;
const XMP_FIELDS = new Map<string, string>();
for (const [namespace, names] of [
  [NS.tiff, ['Make', 'Model']],
  [NS.exif, ['ExposureTime', 'FNumber', 'ISOSpeedRatings', 'PhotographicSensitivity', 'ISOSpeed', 'SensitivityType', 'StandardOutputSensitivity', 'RecommendedExposureIndex', 'ShutterSpeedValue', 'ApertureValue', 'FocalLength', 'FocalLengthIn35mmFilm', 'DateTimeOriginal', 'OffsetTimeOriginal', 'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef', 'LensMake', 'LensModel']],
  [NS.exifEX, ['PhotographicSensitivity', 'ISOSpeed', 'SensitivityType', 'StandardOutputSensitivity', 'RecommendedExposureIndex', 'LensMake', 'LensModel', 'OffsetTimeOriginal']],
  [NS.aux, ['Lens', 'LensMake']],
] as const) for (const name of names) XMP_FIELDS.set(`${namespace}|${name}`, name);

/** SAX resolves namespace URIs, including Photoshop's attributes and RDF arrays.
 * This bounded header block never triggers file/network resolution or DTD expansion.
 */
function readXmp(input?: Uint8Array | string): Fields {
  const values: Fields = new Map();
  if (!input || (typeof input === 'string' ? input.length : input.byteLength) > MAX_BLOCK_BYTES) return values;
  try {
    const xml = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
    if (Buffer.byteLength(xml, 'utf8') > MAX_BLOCK_BYTES || /<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml)) return values;
    const xmlOptions = { xmlns: true, strictEntities: true, trim: false };
    const parser = sax.parser(true, xmlOptions);
    const resources = new Map<string, Fields>();
    const stack: Array<{ uri: string; local: string; rootRdf: boolean; description?: Fields; resource?: Fields; field?: string; text: string; children: boolean }> = [];
    let nodes = 0;
    const add = (resource: Fields | undefined, name: string | undefined, value: string) => {
      const clean = value.trim();
      if (!resource || !name || !clean || clean.length > 512) return;
      const list = resource.get(name) || [];
      if (list.length < 32) { list.push(clean); resource.set(name, list); }
    };
    parser.ondoctype = () => { throw new Error('Unsupported XMP declaration'); };
    parser.onerror = () => { throw new Error('Invalid XMP'); };
    parser.onopentag = node => {
      if (++nodes > 8192 || stack.length >= 32) throw new Error('XMP limit');
      const tag = node as sax.QualifiedTag, parent = stack[stack.length - 1];
      if (parent) parent.children = true;
      const rootRdf = tag.uri === NS.rdf && tag.local === 'RDF' && (stack.length === 0 || stack.length === 1 && parent?.uri === 'adobe:ns:meta/' && parent.local === 'xmpmeta');
      let description: Fields | undefined;
      if (parent?.rootRdf && tag.uri === NS.rdf && tag.local === 'Description') {
        const attributes = Object.values(tag.attributes).filter((value): value is sax.QualifiedAttribute => typeof value !== 'string');
        const identity = attributes.find(value => value.uri === NS.rdf && value.local === 'about')?.value || '';
        if (identity.length <= 512 && !attributes.some(value => value.uri === NS.rdf && value.local === 'nodeID')) {
          description = resources.get(identity) || new Map(); resources.set(identity, description);
        }
      }
      const direct = parent?.description ? XMP_FIELDS.get(`${tag.uri}|${tag.local}`) : undefined;
      // Capture only direct properties of the current image resource. Ingredients,
      // history and other nested objects may contain another image's camera/GPS data.
      const field = direct || (tag.uri === NS.rdf && ['Seq', 'Bag', 'Alt', 'li', 'value'].includes(tag.local) ? parent?.field : undefined);
      const resource = direct ? parent?.description : field ? parent?.resource : undefined;
      stack.push({ uri: tag.uri, local: tag.local, rootRdf, description, resource, field, text: '', children: false });
      for (const attribute of Object.values(tag.attributes)) {
        if (typeof attribute === 'string') continue;
        add(description, XMP_FIELDS.get(`${attribute.uri}|${attribute.local}`), attribute.value);
        if (attribute.uri === NS.rdf && attribute.local === 'resource') add(resource, direct, attribute.value);
      }
    };
    const onText = (text: string) => { const node = stack[stack.length - 1]; if (node?.field) { node.text += text; if (node.text.length > 512) throw new Error('XMP value limit'); } };
    parser.ontext = onText; parser.oncdata = onText;
    parser.onclosetag = () => { const node = stack.pop(); if (node && !node.children) add(node.resource, node.field, node.text); };
    parser.write(xml).close();
    // Empty about identifies the current document. A single named primary resource
    // is also valid; multiple different named resources without it are ambiguous.
    return resources.get('') || (resources.size === 1 ? resources.values().next().value! : new Map());
  } catch { return new Map(); }
}

function scalarValues(values: Array<Value | undefined>): Array<string | number> {
  return values.flatMap(value => value === undefined ? [] : Array.isArray(value) ? value : [value]);
}
function numeric(value: string | number): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\s*\/\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)))?$/u.exec(value.trim());
  if (!match) return;
  const denominator = match[2] === undefined ? 1 : Number(match[2]);
  const result = denominator ? Number(match[1]) / denominator : NaN;
  return Number.isFinite(result) ? result : undefined;
}
function normalize(fields: (name: string) => Array<Value | undefined>): PhotographyMetadata | undefined {
  const result: PhotographyMetadata = {};
  const assign = (name: keyof PhotographyMetadata, candidates: Array<Value | undefined>, number = false) => {
    for (const candidate of scalarValues(candidates)) {
      const parsed = PhotographyMetadataSchema.shape[name].safeParse(number ? numeric(candidate) : candidate);
      if (parsed.success && parsed.data !== undefined) { Object.assign(result, { [name]: parsed.data }); return; }
    }
  };
  for (const [field, names] of [
    ['cameraMake', ['Make']], ['cameraModel', ['Model']], ['lensMake', ['LensMake']], ['lensModel', ['LensModel', 'Lens']],
  ] as const) assign(field, names.flatMap(fields));
  for (const [field, names] of [
    ['focalLengthMm', ['FocalLength']], ['focalLength35mm', ['FocalLengthIn35mmFilm']],
    ['exposureSeconds', ['ExposureTime']], ['aperture', ['FNumber']],
    ['iso', ['ISOSpeed']],
  ] as const) assign(field, names.flatMap(fields), true);
  const apex = (names: string[], transform: (value: number) => number) => scalarValues(names.flatMap(fields)).flatMap(value => { const parsed = numeric(value); return parsed === undefined || Math.abs(parsed) > 64 ? [] : [transform(parsed)]; });
  if (!result.exposureSeconds) assign('exposureSeconds', apex(['ShutterSpeedValue'], value => 2 ** -value), true);
  if (!result.aperture) assign('aperture', apex(['ApertureValue'], value => 2 ** (value / 2)), true);
  const sensitivityType = scalarValues(fields('SensitivityType')).map(numeric).find(value => value !== undefined);
  // 65535 in the legacy sensitivity field is a SHORT saturation sentinel, not a
  // reliable exact ISO. Prefer the type-identified wide field when it is present.
  if (!result.iso) assign('iso', scalarValues(['PhotographicSensitivity', 'ISOSpeedRatings'].flatMap(fields)).filter(value => numeric(value) !== 65535), true);
  // SOS / REI can represent ISO only when SensitivityType explicitly identifies them.
  if (!result.iso && sensitivityType !== undefined) {
    if ([1, 4, 5, 7].includes(sensitivityType)) assign('iso', fields('StandardOutputSensitivity'), true);
    if (!result.iso && [2, 4, 6, 7].includes(sensitivityType)) assign('iso', fields('RecommendedExposureIndex'), true);
  }
  // Never use intellectual content creation, file modification, digitization or
  // upload time as a capture timestamp.
  for (const value of scalarValues(fields('DateTimeOriginal'))) {
    if (typeof value !== 'string') continue;
    const match = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/u.exec(value.trim());
    if (!match) continue;
    const takenAt = `${match[1]}-${match[2]}-${match[3]}T${match[4]}`;
    if (!PhotographyMetadataSchema.shape.takenAt.safeParse(takenAt).success) continue;
    result.takenAt = takenAt; result.takenDate = takenAt.slice(0, 10);
    assign('timezoneOffset', match[5] ? [match[5] === 'Z' ? '+00:00' : match[5]] : fields('OffsetTimeOriginal'));
    break;
  }
  return Object.keys(result).length ? PhotographyMetadataSchema.parse(result) : undefined;
}

const TIFF_NAMES: Record<string, number> = { Make: 0x010f, Model: 0x0110, LensMake: 0xa433, LensModel: 0xa434, FocalLength: 0x920a, FocalLengthIn35mmFilm: 0xa405, ExposureTime: 0x829a, FNumber: 0x829d, ISOSpeed: 0x8833, ISOSpeedRatings: 0x8827, SensitivityType: 0x8830, StandardOutputSensitivity: 0x8831, RecommendedExposureIndex: 0x8832, ShutterSpeedValue: 0x9201, ApertureValue: 0x9202, DateTimeOriginal: 0x9003, OffsetTimeOriginal: 0x9011 };
function coordinate(value: Value | undefined, reference: Value | undefined, latitude: boolean): number | undefined {
  const allowed = latitude ? ['N', 'S'] : ['E', 'W'], maximum = latitude ? 90 : 180;
  let direction = typeof reference === 'string' ? reference.trim().toUpperCase() : '';
  let parts: number[];
  if (Array.isArray(value)) parts = value;
  else if (typeof value === 'string') {
    const match = /^([\d.,\s]+)([NSEW])$/iu.exec(value.trim());
    if (match) {
      const suffix = match[2]!.toUpperCase(), components = match[1]!.split(',');
      if (direction && direction !== suffix || components.some(part => !/^\d+(?:\.\d+)?$/u.test(part.trim()))) return;
      direction = suffix; parts = components.map(part => Number(part.trim()));
    }
    else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value.trim()) && allowed.includes(direction)) parts = [Number(value)];
    else return;
  } else if (typeof value === 'number' && allowed.includes(direction)) parts = [value];
  else return;
  if (!allowed.includes(direction) || !parts.length || parts.length > 3 || parts.some(part => !Number.isFinite(part) || part < 0)) return;
  if (parts[0]! > maximum || parts[1] !== undefined && parts[1] >= 60 || parts[2] !== undefined && parts[2] >= 60) return;
  const decimal = parts[0]! + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600;
  if (decimal > maximum) return;
  return decimal * (direction === 'S' || direction === 'W' ? -1 : 1);
}
function coordinates(latitude: Value | undefined, latRef: Value | undefined, longitude: Value | undefined, lonRef: Value | undefined): PhotoCoordinates | undefined {
  const parsed = PhotoCoordinatesSchema.safeParse({ latitude: coordinate(latitude, latRef, true), longitude: coordinate(longitude, lonRef, false) });
  return parsed.success ? parsed.data : undefined;
}

/** Shared header-only extraction. Valid EXIF fields take precedence over XMP. */
export function extractPhotoMetadata(input: { exif?: Uint8Array; xmp?: Uint8Array | string }): PhotoMetadata {
  const { tags, gps: gpsTags } = readExif(input.exif), xmp = readXmp(input.xmp);
  const exifPhoto = normalize(name => [tags.get(TIFF_NAMES[name]!)]), xmpPhoto = normalize(name => xmp.get(name) || []);
  const photography = exifPhoto || xmpPhoto ? { ...xmpPhoto, ...exifPhoto } : undefined;
  if (photography && exifPhoto?.takenAt) {
    delete photography.timezoneOffset;
    if (exifPhoto.timezoneOffset) photography.timezoneOffset = exifPhoto.timezoneOffset;
  }
  const gps = coordinates(gpsTags.get(2), gpsTags.get(1), gpsTags.get(4), gpsTags.get(3))
    || coordinates(xmp.get('GPSLatitude')?.[0], xmp.get('GPSLatitudeRef')?.[0], xmp.get('GPSLongitude')?.[0], xmp.get('GPSLongitudeRef')?.[0]);
  return { ...(photography ? { photography } : {}), ...(gps ? { gps } : {}) };
}

/** Compatibility entry point that returns only the public allowlist. */
export function extractPhotographyMetadata(exif?: Uint8Array): PhotographyMetadata | undefined {
  return extractPhotoMetadata({ exif }).photography;
}
