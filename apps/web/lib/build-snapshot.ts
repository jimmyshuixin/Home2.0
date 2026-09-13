import { z } from 'zod'
import { SiteSettingsSchema, FitnessSettingsDraftSchema, PublishableCreationSchema, PublishableAlbumSchema, PublishableFitnessEntrySchema, PublishablePhotoSchema, PublishablePlaylistSchema, PublicMediaAssetSchema, IdSchema, UtcTimestampSchema, CreationFormatSchema, SafeHrefSchema } from '@xvyin/contracts'
import type { SiteSnapshot } from './models'
const published = { id: IdSchema, revisionId: IdSchema, publishedAt: UtcTimestampSchema }
// Shared strict schemas reject unrecognized/private fields at every boundary.
// Public projections can only contain explicitly published photos.
export const PublicSnapshotSchema = z.object({
  schemaVersion: z.literal(1), releaseId: IdSchema, settings: SiteSettingsSchema,
  creations: z.array(PublishableCreationSchema.safeExtend({ ...published, formats: z.array(CreationFormatSchema) })),
  albums: z.array(PublishableAlbumSchema.safeExtend({ ...published, photos: z.array(PublishablePhotoSchema.safeExtend({ status: z.literal('published') })) })),
  fitness: z.object({ settings: FitnessSettingsDraftSchema, entries: z.array(PublishableFitnessEntrySchema.safeExtend({ ...published, photos: z.array(PublishablePhotoSchema.safeExtend({ status: z.literal('published') })) })) }).strict(),
  playlists: z.array(PublishablePlaylistSchema.safeExtend(published)), assets: z.array(PublicMediaAssetSchema),
  routeAliases: z.record(SafeHrefSchema, SafeHrefSchema)
}).strict()
export function publicSnapshot(input?: unknown): SiteSnapshot {
  const source = input === undefined ? { schemaVersion: 1, releaseId: 'unpublished', settings: {}, creations: [], albums: [], fitness: { settings: {}, entries: [] }, playlists: [], assets: [], routeAliases: {} } : input
  const snapshot = PublicSnapshotSchema.parse(source), { settings } = snapshot
  return { ...snapshot,
    settings: { ...settings, title: settings.siteTitle, aboutBlocks: settings.about.content.length ? [{ id: 'about', type: 'richtext', document: settings.about }] : [], copyright: settings.footerText },
    playlists: snapshot.playlists.filter((playlist) => playlist.enabled).map((playlist) => ({ ...playlist, title: playlist.name })),
    routeAliases: Object.entries(snapshot.routeAliases).map(([oldPath, targetPath]) => ({ oldPath, targetPath }))
  }
}
