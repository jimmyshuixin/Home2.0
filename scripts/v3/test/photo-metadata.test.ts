import { describe, expect, it } from 'vitest';
import { extractPhotographyMetadata, extractPhotoMetadata } from '../photo-metadata';
import { PhotographyMetadataSchema, PhotoCoordinatesSchema, PublicMediaAssetSchema } from '@xvyin/contracts';

type Tag = [number, string | number | [number, number]];
export function cameraExif(options: { little?: boolean; timestamp?: string; denominator?: number } = {}): Uint8Array {
  const little = options.little ?? true, output = new Uint8Array(4096), view = new DataView(output.buffer);
  output.set(little ? [0x49, 0x49] : [0x4d, 0x4d]);
  const w16 = (offset: number, value: number) => view.setUint16(offset, value, little), w32 = (offset: number, value: number) => view.setUint32(offset, value, little);
  w16(2, 42); w32(4, 8); let textAt = 1024;
  const write = (offset: number, tags: Tag[]) => {
    w16(offset, tags.length);
    tags.forEach(([tag, value], index) => {
      const entry = offset + 2 + index * 12; w16(entry, tag);
      if (typeof value === 'number') { w16(entry + 2, 4); w32(entry + 4, 1); w32(entry + 8, value); }
      else if (typeof value === 'string') {
        const bytes = new TextEncoder().encode(value + '\0'); w16(entry + 2, 2); w32(entry + 4, bytes.length);
        const at = bytes.length <= 4 ? entry + 8 : textAt; if (bytes.length > 4) w32(entry + 8, at);
        output.set(bytes, at); if (bytes.length > 4) textAt += bytes.length;
      } else { w16(entry + 2, 5); w32(entry + 4, 1); w32(entry + 8, textAt); w32(textAt, value[0]); w32(textAt + 4, value[1]); textAt += 8; }
    });
  };
  write(8, [[0x010f, 'Sony'], [0x0110, 'ILCE-7RM5'], [0x8769, 256], [0x8825, 0xfffffff0], [0x013b, 'PRIVATE OWNER']]);
  write(256, [[0x829a, [1, options.denominator ?? 250]], [0x829d, [28, 10]], [0x8827, 400], [0x920a, [85, 1]], [0xa405, 85], [0xa433, 'Sony'], [0xa434, 'FE 85mm F1.8'], [0x9003, options.timestamp ?? '2024:02:29 23:59:58'], [0x9011, '+08:00'], [0xa431, 'PRIVATE SERIAL'], [0x927c, 'PRIVATE MAKER NOTE']]);
  return output.slice(0, textAt);
}

describe('bounded public photography EXIF extraction', () => {
  it.each([true, false])('decodes TIFF in either byte order and does not expose private tags (%s)', little => {
    expect(extractPhotographyMetadata(cameraExif({ little }))).toEqual({ cameraMake: 'Sony', cameraModel: 'ILCE-7RM5', lensMake: 'Sony', lensModel: 'FE 85mm F1.8', focalLengthMm: 85, focalLength35mm: 85, exposureSeconds: 1 / 250, aperture: 2.8, iso: 400, takenAt: '2024-02-29T23:59:58', takenDate: '2024-02-29', timezoneOffset: '+08:00' });
  });
  it('accepts JPEG EXIF preamble and sliced buffers with nonzero offsets', () => {
    const tiff = cameraExif(), wrapped = new Uint8Array(tiff.length + 16); wrapped.set([69, 120, 105, 102, 0, 0], 10); wrapped.set(tiff, 16);
    expect(extractPhotographyMetadata(wrapped.subarray(10))?.cameraModel).toBe('ILCE-7RM5');
  });
  it.each(['2023:02:29 10:00:00', '2024:13:01 10:00:00', '2024:01:01 25:00:00', '0000:00:00 00:00:00', '2024:01:01'])('ignores invalid capture clock %s without inventing upload dates', timestamp => {
    const result = extractPhotographyMetadata(cameraExif({ timestamp }));
    expect(result?.cameraMake).toBe('Sony'); expect(result?.takenAt).toBeUndefined(); expect(result?.takenDate).toBeUndefined(); expect(result?.timezoneOffset).toBeUndefined();
  });
  it('ignores zero rational denominators and tolerates missing/truncated/unbounded blocks', () => {
    expect(extractPhotographyMetadata(cameraExif({ denominator: 0 }))?.exposureSeconds).toBeUndefined();
    expect(extractPhotographyMetadata()).toBeUndefined(); expect(extractPhotographyMetadata(new Uint8Array(1024 * 1024 + 1))).toBeUndefined();
    for (let count = 0; count < 32; count++) expect(() => extractPhotographyMetadata(cameraExif().slice(0, count))).not.toThrow();
    const malformed = cameraExif(); new DataView(malformed.buffer).setUint32(4, 0xffffffff, true); expect(extractPhotographyMetadata(malformed)).toBeUndefined();
  });
  it('rejects any extra private fields and unsafe public values at the contract boundary', () => {
    expect(PhotographyMetadataSchema.safeParse({ cameraModel: '<script>bad</script>' }).success).toBe(false);
    expect(PhotographyMetadataSchema.safeParse({ gpsLatitude: 31 }).success).toBe(false);
    expect(PhotographyMetadataSchema.safeParse({ serialNumber: '1234' }).success).toBe(false);
    expect(PhotographyMetadataSchema.safeParse({ exposureSeconds: Infinity }).success).toBe(false);
    expect(PhotographyMetadataSchema.safeParse({ takenDate: '2023-02-29' }).success).toBe(false);
  });
});

const xml = (content: string, attributes = '') => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:camera="http://ns.adobe.com/tiff/1.0/" xmlns:capture="http://ns.adobe.com/exif/1.0/" xmlns:extra="http://cipa.jp/exif/1.0/" xmlns:aux="http://ns.adobe.com/exif/1.0/aux/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" ${attributes}>${content}</rdf:Description></rdf:RDF></x:xmpmeta>`;
function numericExif(entries: Array<[number, number, number[]]>, gpsEntries: Array<[number, string | number[]]> = []): Uint8Array {
  const bytes = new Uint8Array(4096), view = new DataView(bytes.buffer);
  const w16 = (at: number, value: number) => view.setUint16(at, value, true), w32 = (at: number, value: number) => view.setUint32(at, value, true);
  bytes.set([0x49, 0x49]); w16(2, 42); w32(4, 8); w16(8, entries.length + (gpsEntries.length ? 1 : 0));
  let valueAt = 2048;
  entries.forEach(([tag, type, values], index) => {
    const at = 10 + index * 12, unit = type === 3 ? 2 : type === 4 ? 4 : 8, length = unit === 8 ? values.length / 2 : values.length;
    w16(at, tag); w16(at + 2, type); w32(at + 4, length);
    const inline = length * unit <= 4, target = inline ? at + 8 : valueAt;
    if (!inline) w32(at + 8, target);
    values.forEach((value, i) => type === 3 ? w16(target + i * 2, value) : type === 10 ? view.setInt32(target + i * 4, value, true) : w32(target + i * 4, value));
    if (!inline) valueAt += length * unit;
  });
  if (gpsEntries.length) {
    const at = 10 + entries.length * 12; w16(at, 0x8825); w16(at + 2, 4); w32(at + 4, 1); w32(at + 8, 1024); w16(1024, gpsEntries.length);
    gpsEntries.forEach(([tag, value], index) => {
      const entry = 1026 + index * 12; w16(entry, tag);
      if (typeof value === 'string') { w16(entry + 2, 2); w32(entry + 4, 2); bytes.set([value.charCodeAt(0), 0], entry + 8); }
      else { w16(entry + 2, 5); w32(entry + 4, value.length); w32(entry + 8, valueAt); value.forEach(part => { w32(valueAt, part); w32(valueAt + 4, 1); valueAt += 8; }); }
    });
  }
  return bytes.slice(0, valueAt);
}

describe('EXIF and Photoshop XMP compatibility', () => {
  it('reads an XMP-only Photoshop structure matching the reported Canon PNG without storing the private photograph', () => {
    const xmp = xml('<capture:ISOSpeedRatings><rdf:Seq><rdf:li>100</rdf:li></rdf:Seq></capture:ISOSpeedRatings>', 'camera:Make="Canon" camera:Model="Canon EOS R6m2" extra:LensModel="RF45mm F1.2 STM" capture:ExposureTime="30/1" capture:FNumber="16/1" capture:FocalLength="45/1" capture:DateTimeOriginal="2026-09-27T19:21:19.11+08:00"');
    expect(extractPhotoMetadata({ xmp }).photography).toEqual({ cameraMake: 'Canon', cameraModel: 'Canon EOS R6m2', lensModel: 'RF45mm F1.2 STM', exposureSeconds: 30, aperture: 16, focalLengthMm: 45, iso: 100, takenAt: '2026-09-27T19:21:19', takenDate: '2026-09-27', timezoneOffset: '+08:00' });
  });
  it('handles namespace URIs, entities, RDF arrays and invalid-value fallback without trusting lookalike prefixes', () => {
    const xmp = xml('<camera:Make>Canon &amp; Test</camera:Make><capture:ISOSpeedRatings><rdf:Seq><rdf:li>0</rdf:li><rdf:li>800</rdf:li></rdf:Seq></capture:ISOSpeedRatings><fake:Model xmlns:fake="urn:wrong">Fake camera</fake:Model><aux:Lens>RF lens</aux:Lens>', 'capture:ISOSpeed="0"');
    expect(extractPhotoMetadata({ xmp }).photography).toEqual({ cameraMake: 'Canon & Test', iso: 800, lensModel: 'RF lens' });
  });
  it('retains valid EXIF fields while filling missing fields from XMP and keeps capture clock/offset together', () => {
    const exif = cameraExif({ denominator: 0 });
    // Remove OffsetTimeOriginal while retaining the EXIF local clock.
    new DataView(exif.buffer).setUint16(256 + 2 + 8 * 12, 0xffff, true);
    const xmp = xml('', 'camera:Model="Different XMP camera" capture:ExposureTime="1/60" capture:DateTimeOriginal="2026-09-27T19:21:19+09:00"');
    const photo = extractPhotoMetadata({ exif, xmp }).photography;
    expect(photo).toMatchObject({ cameraModel: 'ILCE-7RM5', exposureSeconds: 1 / 60, takenAt: '2024-02-29T23:59:58' });
    expect(photo?.timezoneOffset).toBeUndefined();
  });
  it('supports ISO arrays, valid ISO fallback and signed APEX values', () => {
    const exif = numericExif([[0x8833, 4, [0]], [0x8827, 3, [0, 400, 800]], [0x9201, 10, [-1, 1]], [0x9202, 5, [3, 1]]]);
    expect(extractPhotographyMetadata(exif)).toEqual({ iso: 400, exposureSeconds: 2, aperture: 2 ** 1.5 });
    expect(extractPhotographyMetadata(numericExif([[0x829a, 5, [1, 125]], [0x9201, 10, [-1, 1]], [0x829d, 5, [4, 1]], [0x9202, 5, [3, 1]]]))).toMatchObject({ exposureSeconds: 1 / 125, aperture: 4 });
  });
  it('never treats modification, generic creation or digitization times as the capture date', () => {
    expect(extractPhotoMetadata({ xmp: xml('<xmp:ModifyDate>2026-01-01T00:00:00Z</xmp:ModifyDate><xmp:CreateDate>2026-01-01T00:00:00Z</xmp:CreateDate><photoshop:DateCreated>2026-01-01T00:00:00Z</photoshop:DateCreated><capture:DateTimeDigitized>2026-01-01T00:00:00Z</capture:DateTimeDigitized>') })).toEqual({});
    expect(extractPhotoMetadata({ xmp: xml('', 'capture:DateTimeOriginal="2023-02-29T12:00:00Z"') })).toEqual({});
  });
  it.each([
    '<!DOCTYPE root [<!ENTITY leak SYSTEM "file:///secret">]><root>&leak;</root>',
    xml('<camera:Model>Valid</camera:Model><broken>'),
    xml('<camera:Model>&unknown;</camera:Model>'),
    xml('<node>'.repeat(33) + '</node>'.repeat(33)),
    xml('<node/>'.repeat(8193)),
    ' '.repeat(1024 * 1024 + 1),
  ])('ignores unsafe or malformed XML without losing valid EXIF', xmp => {
    expect(extractPhotoMetadata({ exif: cameraExif(), xmp }).photography?.cameraModel).toBe('ILCE-7RM5');
    expect(extractPhotoMetadata({ xmp })).toEqual({});
  });
  it('keeps valid GPS private, preserves southern/western signs and refuses missing hemispheres', () => {
    const exif = numericExif([], [[1, 'S'], [2, [31, 12, 0]], [3, 'W'], [4, [121, 30, 0]]]);
    const metadata = extractPhotoMetadata({ exif });
    expect(metadata).toEqual({ gps: { latitude: -31.2, longitude: -121.5 } });
    expect(extractPhotographyMetadata(exif)).toBeUndefined();
    expect(extractPhotoMetadata({ exif: numericExif([], [[2, [31, 12, 0]], [4, [121, 30, 0]]]) }).gps).toBeUndefined();
    expect(extractPhotoMetadata({ xmp: xml('', 'capture:GPSLatitude="31,12.0000S" capture:GPSLongitude="121,30,0W"') }).gps).toEqual(metadata.gps);
    expect(PublicMediaAssetSchema.safeParse({ id: 'image', kind: 'image', gps: metadata.gps, variants: [{ role: 'thumb', url: '/thumb', mime: 'image/webp', bytes: 1 }] }).success).toBe(false);
  });
  it.each(['91,0N', '31,60N', '31,,0N', '31,0W', '31N<script>'])('rejects invalid latitude %s', latitude => {
    expect(extractPhotoMetadata({ xmp: xml('', `capture:GPSLatitude="${latitude.replaceAll('<', '&lt;')}" capture:GPSLongitude="121,30E"`) }).gps).toBeUndefined();
  });
  it('normalizes signed zero at the private contract boundary for store serialization', () => {
    const result = PhotoCoordinatesSchema.parse({ latitude: -0, longitude: -0 });
    expect(Object.is(result.latitude, -0)).toBe(false); expect(Object.is(result.longitude, -0)).toBe(false);
  });
  it('recovers wide ISO values instead of publishing a saturated SHORT value of 65535', () => {
    const exif = numericExif([[0x8827, 3, [65535]], [0x8830, 3, [1]], [0x8831, 4, [102400]]]);
    expect(extractPhotographyMetadata(exif)?.iso).toBe(102400);
    expect(extractPhotographyMetadata(numericExif([[0x8827, 3, [65535]]]))?.iso).toBeUndefined();
    expect(extractPhotoMetadata({ xmp: xml('', 'capture:ISOSpeedRatings="65535" extra:SensitivityType="1" extra:StandardOutputSensitivity="102400"') }).photography?.iso).toBe(102400);
  });
  it('does not attribute camera or GPS data from nested ingredients or other RDF resources to the current image', () => {
    const nested = '<mm:Ingredients xmlns:mm="http://ns.adobe.com/xap/1.0/mm/"><rdf:Bag><rdf:li rdf:parseType="Resource"><camera:Model>Other camera</camera:Model><capture:GPSLatitude>11,0N</capture:GPSLatitude><capture:GPSLongitude>22,0E</capture:GPSLongitude></rdf:li></rdf:Bag></mm:Ingredients>';
    expect(extractPhotoMetadata({ xmp: xml(nested) })).toEqual({});
    const other = '<rdf:Description rdf:about="urn:other-photo" xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="11,0N" exif:GPSLongitude="22,0E"/>';
    const current = xml('', 'camera:Make="Canon"').replace('</rdf:RDF>', `${other}</rdf:RDF>`);
    expect(extractPhotoMetadata({ xmp: current })).toEqual({ photography: { cameraMake: 'Canon' } });
    const named = xml('', 'rdf:about="urn:current-photo" camera:Make="Canon"');
    expect(extractPhotoMetadata({ xmp: named })).toEqual({ photography: { cameraMake: 'Canon' } });
    expect(extractPhotoMetadata({ xmp: named.replace('</rdf:RDF>', `${other}</rdf:RDF>`) })).toEqual({});
  });
});
