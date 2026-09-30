import { z } from 'zod'
import { SiteSettingsSchema, FitnessSettingsDraftSchema, PublishableCreationSchema, PublishableAlbumSchema, AlbumPhotoSchema, PublishableFitnessEntrySchema, PublishablePhotoSchema, PublishablePlaylistSchema, PublicMediaAssetSchema, IdSchema, UtcTimestampSchema, CreationFormatSchema, SafeHrefSchema } from '@xvyin/contracts'
import type { SiteSnapshot } from './models'
import { comparisonMediaProblems } from '@xvyin/contracts'
const published = { id: IdSchema, revisionId: IdSchema, publishedAt: UtcTimestampSchema }
// Shared strict schemas reject unrecognized/private fields at every boundary.
// Public projections can only contain explicitly published photos.
export const PublicSnapshotSchema = z.object({
  schemaVersion: z.literal(1), releaseId: IdSchema, settings: SiteSettingsSchema,
  creations: z.array(PublishableCreationSchema.safeExtend({ ...published, formats: z.array(CreationFormatSchema) })),
  albums: z.array(PublishableAlbumSchema.safeExtend({ ...published, photos: z.array(AlbumPhotoSchema.safeExtend({ status: z.literal('published') })) })),
  fitness: z.object({ settings: FitnessSettingsDraftSchema, entries: z.array(PublishableFitnessEntrySchema.safeExtend({ ...published, photos: z.array(PublishablePhotoSchema.safeExtend({ status: z.literal('published') })) })) }).strict(),
  playlists: z.array(PublishablePlaylistSchema.safeExtend(published)), assets: z.array(PublicMediaAssetSchema),
  routeAliases: z.record(SafeHrefSchema, SafeHrefSchema)
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.settings.now && (!snapshot.settings.now.enabled || !snapshot.settings.now.text.trim() || !snapshot.settings.now.updatedAt)) {
    ctx.addIssue({ code: 'custom', path: ['settings', 'now'], message: 'Public now must be enabled, nonempty and have an update timestamp' })
  }
  for (const problem of comparisonMediaProblems(snapshot.creations, snapshot.assets)) {
    ctx.addIssue({ code: 'custom', path: ['creations', problem.entryIndex, 'blocks', problem.blockIndex, problem.side, 'assetId'], message: problem.message })
  }
  const available = { creations: new Set(snapshot.creations.map(item => item.id)), albums: new Set(snapshot.albums.map(item => item.id)) }
  snapshot.settings.topics?.forEach((topic, index) => {
    if (!topic.enabled || !topic.members.length) ctx.addIssue({ code: 'custom', path: ['settings', 'topics', index], message: 'Public topics must be enabled and nonempty' })
    topic.members.forEach((member, position) => {
      if (!available[member.collection].has(member.id)) ctx.addIssue({ code: 'custom', path: ['settings', 'topics', index, 'members', position], message: 'Topic member is not in this public release' })
    })
  })
})
export function publicSnapshot(input?: unknown): SiteSnapshot {
  const source = input === undefined ? { schemaVersion: 1, releaseId: 'unpublished', settings: {}, creations: [], albums: [], fitness: { settings: {}, entries: [] }, playlists: [], assets: [], routeAliases: {} } : input
  const snapshot = PublicSnapshotSchema.parse(source), { settings } = snapshot
  return { ...snapshot,
    settings: { ...settings, title: settings.siteTitle, aboutBlocks: settings.about.content.length ? [{ id: 'about', type: 'richtext', document: settings.about }] : [], copyright: settings.footerText },
    playlists: snapshot.playlists.filter((playlist) => playlist.enabled).map((playlist) => ({ ...playlist, title: playlist.name })),
    routeAliases: Object.entries(snapshot.routeAliases).map(([oldPath, targetPath]) => ({ oldPath, targetPath }))
  }
}
