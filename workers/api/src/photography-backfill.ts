import { z } from 'zod';
import { IdSchema, MEDIA_LIMITS, PHOTO_METADATA_EXTRACTOR_VERSION, PhotographyMetadataSchema, PhotoCoordinatesSchema, Sha256Schema } from '@xvyin/contracts';
import type { MediaAsset } from './media';
import type { Store } from './store/types';
import { assert } from './errors';

const completion = z.object({
  sha256: Sha256Schema, extractorVersion: z.literal(PHOTO_METADATA_EXTRACTOR_VERSION),
  photography: PhotographyMetadataSchema.refine(value => Object.keys(value).length > 0).nullable(),
  gps: PhotoCoordinatesSchema.nullable().optional(),
}).strict();
function eligible(asset: MediaAsset | null): asset is MediaAsset & { metadata: NonNullable<MediaAsset['metadata']> & { kind: 'image' } } {
  return Boolean(asset && asset.kind === 'image' && asset.status === 'ready' && (!asset.lifecycle || asset.lifecycle === 'active') && asset.metadata?.kind === 'image'
    && asset.originalBytes > 0 && asset.originalBytes <= MEDIA_LIMITS.imageBytes && asset.metadata.bytes === asset.originalBytes && Sha256Schema.safeParse(asset.metadata.sha256).success);
}
function currentExtraction(asset: MediaAsset): boolean {
  return asset.photographyBackfill?.version === PHOTO_METADATA_EXTRACTOR_VERSION && asset.photographyBackfill.sha256 === asset.metadata?.sha256;
}
/** Maintenance runs add the same allowlisted EXIF/XMP fields as new uploads.
 * Original objects, derivatives, content drafts and quota are never written here.
 */
export class PhotographyBackfill {
  constructor(private readonly store: Store, private readonly bucket: R2Bucket, private readonly now: () => number) {}
  async page(cursor?: string) {
    const page = await this.store.list<MediaAsset>('media', { limit: 20, ...(cursor ? { cursor } : {}) });
    const items = page.items.map(row => row.data).filter(asset => eligible(asset) && !currentExtraction(asset))
      .map(asset => ({ id: asset.id, bytes: asset.originalBytes, mime: asset.metadata!.detectedMime, sha256: asset.metadata!.sha256, sourceUrl: `/api/v1/internal/photography/${asset.id}/source` }));
    return { items, nextCursor: page.nextCursor, scanned: page.items.length };
  }
  async source(id: string): Promise<Response> {
    IdSchema.parse(id);
    const asset = await this.store.get<MediaAsset>(`media/${id}`);
    assert(eligible(asset), 'PHOTO_NOT_READY', 409, '照片原件尚不可用于参数识别');
    const object = await this.bucket.get(asset.originalKey);
    assert(object && object.size === asset.originalBytes, 'ORIGINAL_MISMATCH', 422, '照片原件大小与已验证记录不符');
    return new Response(object.body, { headers: { 'content-type': asset.metadata.detectedMime, 'content-length': String(object.size), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  }
  async complete(id: string, input: unknown): Promise<{ status: 'updated' | 'no_exif' | 'already_done' }> {
    IdSchema.parse(id); const values = completion.parse(input);
    return this.store.transaction(async tx => {
      const asset = await tx.get<MediaAsset>(`media/${id}`);
      assert(eligible(asset), 'PHOTO_NOT_READY', 409, '照片状态已改变，请重新识别');
      assert(asset.metadata.sha256 === values.sha256, 'ORIGINAL_MISMATCH', 422, '摄影参数不属于此照片原件');
      if (currentExtraction(asset)) return { status: 'already_done' };
      const at = new Date(this.now()).toISOString(), status = values.photography || values.gps ? 'updated' : 'no_exif';
      // Existing valid fields win. A rescan fills missing fields, and absent/failed
      // reads cannot erase earlier values. Album/manual dates are never touched.
      const photography = values.photography || asset.metadata.photography ? { ...values.photography, ...asset.metadata.photography } : undefined;
      const previousPhoto = asset.metadata.photography;
      // Version 1 treated the legacy SHORT saturation sentinel as an exact ISO.
      // Only this known invalid historical value may yield to a verified new ISO.
      if (photography && previousPhoto?.iso === 65535 && values.photography?.iso && values.photography.iso !== 65535) photography.iso = values.photography.iso;
      if (photography && (previousPhoto?.takenAt || previousPhoto?.takenDate)) {
        // Keep a timestamp and its offset together; do not attach a new XMP offset
        // to a different earlier capture clock.
        delete photography.takenAt; delete photography.takenDate; delete photography.timezoneOffset;
        if (previousPhoto.takenAt) photography.takenAt = previousPhoto.takenAt;
        if (previousPhoto.takenDate) photography.takenDate = previousPhoto.takenDate;
        if (previousPhoto.timezoneOffset) photography.timezoneOffset = previousPhoto.timezoneOffset;
      }
      const gps = asset.metadata.gps || values.gps;
      const next: MediaAsset = { ...asset, metadata: { ...asset.metadata, ...(photography ? { photography } : {}), ...(gps ? { gps } : {}) },
        version: (asset.version || 1) + 1, updatedAt: at, photographyBackfill: { version: PHOTO_METADATA_EXTRACTOR_VERSION, sha256: values.sha256, checkedAt: at, status } };
      tx.put(`media/${id}`, next);
      return { status };
    });
  }
}
