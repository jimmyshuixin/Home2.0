import { PhotographyMetadataSchema, type PhotographyMetadata } from '@xvyin/contracts';

/** Read only public photography tags from Sharp's bounded EXIF/TIFF block.
 * No recursive IFD walking, MakerNote parsing, GPS traversal or whole-file read.
 * Malformed/unsupported optional metadata never prevents a valid image upload.
 */
export function extractPhotographyMetadata(exif?: Uint8Array): PhotographyMetadata | undefined {
  if (!exif || exif.byteLength < 8 || exif.byteLength > 1024 * 1024) return;
  try {
    const start = exif[0] === 0x45 && exif[1] === 0x78 && exif[2] === 0x69 && exif[3] === 0x66 && exif[4] === 0 && exif[5] === 0 ? 6 : 0;
    const bytes = exif.subarray(start), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = bytes[0] === 0x49 && bytes[1] === 0x49;
    if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d) || view.getUint16(2, little) !== 42) return;
    const u16 = (offset: number) => view.getUint16(offset, little), u32 = (offset: number) => view.getUint32(offset, little);
    const wanted = new Set([0x010f, 0x0110, 0x8769, 0x829a, 0x829d, 0x8827, 0x8833, 0x9003, 0x9011, 0x920a, 0xa405, 0xa433, 0xa434]);
    const tags = new Map<number, string | number>();
    const readDirectory = (offset: number) => {
      if (!Number.isSafeInteger(offset) || offset < 8 || offset + 2 > bytes.byteLength) return;
      const count = u16(offset);
      if (count > 512 || offset + 2 + count * 12 > bytes.byteLength) return;
      for (let index = 0; index < count; index++) {
        const entry = offset + 2 + index * 12, tag = u16(entry);
        if (!wanted.has(tag) || tags.has(tag)) continue;
        const type = u16(entry + 2), length = u32(entry + 4), unit = ({ 2: 1, 3: 2, 4: 4, 5: 8 } as Record<number, number>)[type];
        if (!unit || !length || length > 512 || type !== 2 && length !== 1) continue;
        const size = unit * length, valueAt = size <= 4 ? entry + 8 : u32(entry + 8);
        if (valueAt < 0 || valueAt + size > bytes.byteLength) continue;
        if (type === 2) {
          const value = new TextDecoder().decode(bytes.subarray(valueAt, valueAt + size)).split('\0', 1)[0]!.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
          if (value) tags.set(tag, value);
        } else if (type === 3) tags.set(tag, u16(valueAt));
        else if (type === 4) tags.set(tag, u32(valueAt));
        else { const denominator = u32(valueAt + 4); if (denominator) tags.set(tag, u32(valueAt) / denominator); }
      }
    };
    readDirectory(u32(4));
    const exifDirectory = tags.get(0x8769);
    if (typeof exifDirectory === 'number') readDirectory(exifDirectory);
    const result: PhotographyMetadata = {};
    const fields: Array<[keyof PhotographyMetadata, number]> = [
      ['cameraMake', 0x010f], ['cameraModel', 0x0110], ['lensMake', 0xa433], ['lensModel', 0xa434],
      ['focalLengthMm', 0x920a], ['focalLength35mm', 0xa405], ['exposureSeconds', 0x829a], ['aperture', 0x829d],
      ['iso', tags.has(0x8833) ? 0x8833 : 0x8827], ['timezoneOffset', 0x9011],
    ];
    for (const [name, tag] of fields) {
      const parsed = PhotographyMetadataSchema.shape[name].safeParse(tags.get(tag));
      if (parsed.success && parsed.data !== undefined) Object.assign(result, { [name]: parsed.data });
    }
    const timestamp = tags.get(0x9003);
    if (typeof timestamp === 'string' && /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/u.test(timestamp)) {
      const takenAt = timestamp.slice(0, 10).replaceAll(':', '-') + 'T' + timestamp.slice(11);
      if (PhotographyMetadataSchema.shape.takenAt.safeParse(takenAt).success) { result.takenAt = takenAt; result.takenDate = takenAt.slice(0, 10); }
    }
    // An offset without a trustworthy capture timestamp has no useful meaning.
    if (!result.takenAt) delete result.timezoneOffset;
    return Object.keys(result).length ? PhotographyMetadataSchema.parse(result) : undefined;
  } catch { return; }
}
