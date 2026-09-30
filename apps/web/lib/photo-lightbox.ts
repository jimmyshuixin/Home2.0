import type { Photo, Variant } from './models'

export type PhotoSlide = {
  src: string; width: number; height: number; alt: string; photoIndex: number
  srcset?: string
}
export type PhotoContext = { albumId: string; photoId?: string; albumTitle: string; albumSlug: string }
export function photoViewerTarget(photo?: Photo, albumId?: string, contexts?: Record<string, PhotoContext>) {
  if (!photo) return undefined
  const context = contexts?.[photo.id || photo.assetId]
  const parentId = context ? context.albumId : albumId, id = context ? context.photoId : photo.id
  return parentId && id ? { type: 'photo' as const, id, parentId } : undefined
}

/** Reuse public derivatives only. Do not pass an asset/photo object to the viewer. */
export function photoLightboxSlides(
  photos: readonly Photo[],
  variantFor: (assetId: string) => Variant | undefined,
  sourceSetFor: (assetId: string) => string | undefined,
): PhotoSlide[] {
  const slides: PhotoSlide[] = []
  photos.forEach((photo, photoIndex) => {
    const image = variantFor(photo.assetId)
    if (!image || !['large', 'content', 'thumb'].includes(image.role) || !image.mime.startsWith('image/')
      || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
      || (image.width ?? 0) <= 0 || (image.height ?? 0) <= 0) return
    const srcset = sourceSetFor(photo.assetId)
    slides.push({ src: image.url, width: image.width!, height: image.height!, alt: photo.alt,
      photoIndex, ...(srcset ? { srcset } : {}) })
  })
  return slides
}

export function photoLightboxMotion(reduced: boolean) {
  return { showHideAnimationType: reduced ? 'none' as const : 'fade' as const,
    showAnimationDuration: reduced ? 0 : 180, hideAnimationDuration: reduced ? 0 : 180,
    zoomAnimationDuration: reduced ? 0 : 180 }
}

export interface PhotoViewerLease {
  isCurrent(): boolean
  markOpen(): boolean
  release(): void
}

/** One open intent across all gallery components, including a slow first import. */
export function createPhotoViewerArbiter() {
  let active: { phase: 'opening' | 'open'; cancel: () => void } | undefined
  return {
    request(cancel: () => void): PhotoViewerLease | undefined {
      // An already mounted viewer owns the page until its close/unmount cleanup.
      if (active?.phase === 'open') return undefined
      const previous = active
      const current = { phase: 'opening' as 'opening' | 'open', cancel }
      active = current
      previous?.cancel()
      return {
        isCurrent: () => active === current,
        markOpen() {
          if (active !== current) return false
          current.phase = 'open'
          return true
        },
        release() { if (active === current) active = undefined },
      }
    },
  }
}

let browserArbiter: ReturnType<typeof createPhotoViewerArbiter> | undefined
export function photoViewerArbiter() {
  if (typeof window === 'undefined') throw new Error('Photo viewer requests require a browser')
  return browserArbiter ||= createPhotoViewerArbiter()
}
