import { describe, expect, it, vi } from 'vitest'
import { createPhotoViewerArbiter, photoLightboxMotion, photoLightboxSlides } from '../lib/photo-lightbox'
import type { Photo, Variant } from '../lib/models'
import { imageSourceSet } from '../lib/image-variants'

const photo = (assetId = 'image'): Photo => ({ assetId, alt: '窗前的光', id: assetId, status: 'published' })
const variant = (overrides: Partial<Variant> = {}): Variant => ({
  role: 'large', mime: 'image/webp', bytes: 2048,
  url: '/api/v1/media/image/large', width: 2400, height: 1600, ...overrides,
})

describe('public photo viewer data', () => {
  it('preserves derivative dimensions, alt text and responsive sources without fetching an original', () => {
    const variants = [variant({ role: 'content', width: 1200, height: 800, url: '/api/v1/media/image/content' }), variant()]
    expect(photoLightboxSlides([photo()], () => variants[1], () => imageSourceSet(variants))).toEqual([{
      src: '/api/v1/media/image/large', width: 2400, height: 1600, alt: '窗前的光', photoIndex: 0,
      srcset: '/api/v1/media/image/content 1200w, /api/v1/media/image/large 2400w',
    }])
  })

  it('does not pass private fields or even published location data into PhotoSwipe', () => {
    const input = { ...photo(), caption: '<img src=x onerror=alert(1)>',
      location: { latitude: 30, longitude: 120, precision: 'city', label: '公开城市' },
      gps: { latitude: 31.123456, longitude: 121.654321 }, originalKey: 'private/original',
      photography: { owner: 'private-owner', serialNumber: 'private-serial' },
    } as Photo
    const result = photoLightboxSlides([input], () => variant(), () => undefined)
    expect(result).toEqual([{ src: '/api/v1/media/image/large', width: 2400, height: 1600, alt: '窗前的光', photoIndex: 0 }])
    expect(input).toHaveProperty('gps') // Selection must not mutate the caller's data.
  })

  it('retains original photo indices when an asset is unavailable', () => {
    const result = photoLightboxSlides([photo('missing'), photo('second'), photo('third')], id => id === 'missing' ? undefined : variant(), () => undefined)
    expect(result.map(item => item.photoIndex)).toEqual([1, 2])
    expect(result.findIndex(item => item.photoIndex === 2)).toBe(1)
  })

  it.each([
    { width: undefined }, { height: undefined }, { width: 0 }, { height: -1 }, { width: Infinity }, { height: 1.5 },
    { role: 'download' as const }, { role: 'poster' as const }, { mime: 'video/mp4' as const },
  ])('does not invent dimensions or choose a non-photo derivative: %j', overrides => {
    expect(photoLightboxSlides([photo()], () => variant(overrides), () => undefined)).toEqual([])
  })

  it.each(['content', 'thumb'] as const)('accepts the existing %s fallback without constructing another URL', role => {
    expect(photoLightboxSlides([photo()], () => variant({ role, url: `/api/v1/media/image/${role}` }), () => undefined)[0]?.src)
      .toBe(`/api/v1/media/image/${role}`)
  })

  it('keeps an empty gallery empty', () => {
    expect(photoLightboxSlides([], () => { throw new Error('Unexpected asset lookup') }, () => undefined)).toEqual([])
  })
})

describe('reduced motion in the photo viewer', () => {
  it('removes open/close and zoom animation when reduction is requested, including after a preference change', () => {
    const liveOptions = photoLightboxMotion(false)
    Object.assign(liveOptions, photoLightboxMotion(true))
    expect(liveOptions.showHideAnimationType).toBe('none')
    expect([liveOptions.showAnimationDuration, liveOptions.hideAnimationDuration, liveOptions.zoomAnimationDuration]).toEqual([0, 0, 0])
  })
})

describe('one viewer across independent photo galleries', () => {
  it('lets the latest pending click replace another gallery before its import completes', () => {
    const arbiter = createPhotoViewerArbiter(), cancelFirst = vi.fn()
    const first = arbiter.request(cancelFirst)!, second = arbiter.request(vi.fn())!
    expect(cancelFirst).toHaveBeenCalledOnce()
    expect(first.isCurrent()).toBe(false)
    expect(first.markOpen()).toBe(false)
    expect(second.markOpen()).toBe(true)
  })

  it('does not let superseded cleanup release the new gallery request', () => {
    const arbiter = createPhotoViewerArbiter()
    const first = arbiter.request(() => first?.release())!
    const second = arbiter.request(vi.fn())!
    first.release()
    expect(second.isCurrent()).toBe(true)
    expect(second.markOpen()).toBe(true)
  })

  it('rejects another open intent while a mounted viewer owns the page', () => {
    const arbiter = createPhotoViewerArbiter(), cancel = vi.fn()
    const first = arbiter.request(cancel)!
    first.markOpen()
    expect(arbiter.request(vi.fn())).toBeUndefined()
    expect(cancel).not.toHaveBeenCalled()
    expect(first.isCurrent()).toBe(true)
    first.release()
    expect(arbiter.request(vi.fn())?.markOpen()).toBe(true)
  })

  it.each(['cancel', 'import failure', 'unmount'])('releases a pending %s without allowing its late import to open', () => {
    const arbiter = createPhotoViewerArbiter(), pending = arbiter.request(vi.fn())!
    pending.release()
    expect(pending.markOpen()).toBe(false)
    const replacement = arbiter.request(vi.fn())!
    expect(replacement.markOpen()).toBe(true)
    pending.release()
    expect(replacement.isCurrent()).toBe(true)
  })
})
