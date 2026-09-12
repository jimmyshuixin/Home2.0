import type { ContentBlock, CreationDraft, AlbumDraft, AlbumPhoto, FitnessEntryDraft, FitnessSettingsDraft, PlaylistDraft, PlaylistTrack, PublicMediaAsset, PublicMediaVariant, SiteSettings, RichTextDocument, RichParagraph, RichHeading, RichList, RichListItem, RichInline, ProviderRef } from '@xvyin/contracts'
export type Block = ContentBlock
export type RichNode = RichTextDocument | RichParagraph | RichHeading | RichList | RichListItem | RichInline
export type Photo = Pick<AlbumPhoto, 'assetId' | 'alt'> & Partial<Omit<AlbumPhoto, 'assetId' | 'alt'>> & { title?: string }
export type Variant = PublicMediaVariant
export type Asset = PublicMediaAsset
type Published<T> = T & { id: string; revisionId: string; publishedAt: string }
export type Creation = Published<CreationDraft>
export type Album = Published<AlbumDraft>
export type FitnessEntry = Published<FitnessEntryDraft>
export type Track = PlaylistTrack & { url?: string; audioUrl?: string; coverUrl?: string; lyrics?: string; lyricsUrl?: string; sourceUrl?: string; durationMs?: number }
export type Playlist = Omit<Published<PlaylistDraft>, 'tracks'> & { title: string; tracks: Track[]; sourceUrl?: string }
export type SiteSnapshot = { releaseId: string; settings: SiteSettings & { title: string; aboutBlocks: Block[]; copyright: string }; creations: Creation[]; albums: Album[]; fitness: { settings: FitnessSettingsDraft; entries: FitnessEntry[] }; playlists: Playlist[]; assets: Asset[]; routeAliases: { oldPath: string; targetPath: string }[] }
