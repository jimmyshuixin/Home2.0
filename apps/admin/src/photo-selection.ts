import type { FitnessPhotoDraft } from '@xvyin/contracts';
import type { MediaItem } from './api';

/** Attach only ready images, preserve the user's order and never replace manual metadata. */
export function appendReadyPhotos(photos: FitnessPhotoDraft[], items: MediaItem[], limit: number): FitnessPhotoDraft[] {
  const ids = new Set(photos.map(photo => photo.assetId));
  const next = [...photos];
  for (const item of items) {
    if (next.length >= limit) break;
    if (item.kind !== 'image' || (item.processingStatus || item.status) !== 'ready' || ids.has(item.id)) continue;
    ids.add(item.id);
    next.push({ id: crypto.randomUUID(), assetId: item.id, alt: (item.originalName || '照片').replace(/\.[^.]+$/, '').slice(0, 500), caption: '', photoDate: item.metadata?.photography?.takenDate || null, sortOrder: next.length, featured: false, status: 'draft' });
  }
  return next;
}
export function applyPhotoMetadata(photo: FitnessPhotoDraft, item: MediaItem) {
  if (!photo.photoDate && item.metadata?.photography?.takenDate) photo.photoDate = item.metadata.photography.takenDate;
  if (!photo.alt) photo.alt = (item.originalName || '照片').replace(/\.[^.]+$/, '').slice(0, 500);
}
