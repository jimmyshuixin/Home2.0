import { describe, it, expect, vi } from 'vitest'
import { publicSnapshot, PublicSnapshotSchema } from '../lib/build-snapshot'
import { MediaFocusManager } from '../lib/media-focus'

describe('public build input boundary', () => {
  const empty = () => ({ schemaVersion: 1, releaseId: 'qa-release', settings: {}, creations: [], albums: [], fitness: { settings: {}, entries: [] }, playlists: [], assets: [], routeAliases: {} })
  it('starts with actual empty lists and a null fitness start date', () => {
    const snapshot = publicSnapshot()
    expect(snapshot.creations).toEqual([])
    expect(snapshot.assets).toEqual([])
    expect(snapshot.fitness.settings.startDate).toBeNull()
    expect(snapshot.settings.intro).toBe('')
  })
  it('rejects credential or private media fields instead of stripping them', () => {
    expect(() => publicSnapshot({ ...empty(), password: 'do-not-render' })).toThrow()
    expect(() => publicSnapshot({ ...empty(), assets: [{ id: 'a', kind: 'image', originalKey: 'private/original', variants: [{ role: 'content', url: '/api/v1/media/a/content', mime: 'image/webp', bytes: 200 }] }] })).toThrow()
  })
  it('rejects photos selected as draft even inside an otherwise public album', () => {
    expect(PublicSnapshotSchema.safeParse({ ...empty(), albums: [{ id: 'album', revisionId: 'rev', publishedAt: '2026-09-12T00:00:00.000Z', title: 'QA fixture', slug: 'qa-fixture', photos: [{ id: 'photo', assetId: 'image', alt: 'QA fixture', status: 'draft' }] }] }).success).toBe(false)
  })
  it('preserves an explicitly empty intro and maps only declared route aliases', () => {
    const snapshot = publicSnapshot({ ...empty(), settings: { intro: '' }, routeAliases: { '/old': '/creations/new' } })
    expect(snapshot.settings.intro).toBe('')
    expect(snapshot.routeAliases).toEqual([{ oldPath: '/old', targetPath: '/creations/new' }])
  })
  it('reads an old published greeting without mutating its immutable snapshot', () => {
    const input = { ...empty(), settings: { heroTitle: 'hello！i‘m 虚宁', intro: 'Existing introduction' } }
    const serialized = JSON.stringify(input)
    expect(publicSnapshot(input).settings).toMatchObject({ heroTitle: 'Hello! I am 虚宁', intro: 'Existing introduction' })
    expect(JSON.stringify(input)).toBe(serialized)
  })
})
describe('actual media focus control', () => {
  it('pauses the previous element and never resumes it after the new one ends', () => {
    const manager = new MediaFocusManager()
    const first = { pause: vi.fn(), play: vi.fn() } as unknown as HTMLMediaElement
    const second = { pause: vi.fn(), play: vi.fn() } as unknown as HTMLMediaElement
    manager.activate(first); manager.activate(second); manager.release(second)
    expect(first.pause).toHaveBeenCalledTimes(1)
    expect(first.play).not.toHaveBeenCalled()
    expect(second.pause).not.toHaveBeenCalled()
  })
})
