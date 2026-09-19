import { describe, expect, it } from 'vitest';
import { extractPhotographyMetadata } from '../photo-metadata';
import { PhotographyMetadataSchema } from '@xvyin/contracts';

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
