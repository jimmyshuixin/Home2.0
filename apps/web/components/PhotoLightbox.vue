<script setup lang="ts">
// This component and the PhotoSwipe core/CSS are imported only after opening a photo.
import PhotoSwipe from 'photoswipe'
import 'photoswipe/style.css'
import { displayDate, type Photo } from '~/lib/site'
import { photoLightboxMotion, photoViewerTarget, type PhotoContext, type PhotoSlide } from '~/lib/photo-lightbox'

const props = defineProps<{ photos: Photo[]; slides: PhotoSlide[]; index: number; trigger: HTMLElement; albumId?: string; photoContexts?: Record<string, PhotoContext> }>()
const emit = defineEmits<{ close: [] }>()
const current = ref(props.index), captionHost = shallowRef<HTMLElement>(), imageFailed = ref(false)
const photo = computed(() => props.photos[props.slides[current.value]?.photoIndex ?? -1])
const context = computed(() => photo.value && props.photoContexts?.[photo.value.id || photo.value.assetId])
const target = computed(() => photoViewerTarget(photo.value, props.albumId, props.photoContexts))
const captionId = useId()
let viewer: PhotoSwipe | undefined, disposed = false, previousOverflow = ''
let motion: MediaQueryList | undefined
let pageRoot: HTMLElement | null = null, previousInert = false, pageLocked = false

function restorePage() {
  if (!pageLocked) return
  pageLocked = false
  document.documentElement.style.overflow = previousOverflow
  if (pageRoot) pageRoot.inert = previousInert
}

function announcePhoto() {
  if (props.albumId || props.photoContexts) window.dispatchEvent(new CustomEvent('xvyin-photo-view', { detail: target.value }))
}
function applyMotion() { if (viewer && motion) Object.assign(viewer.options, photoLightboxMotion(motion.matches)) }
function retry() { imageFailed.value = false; viewer?.refreshSlideContent(current.value) }

onMounted(() => {
  motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  previousOverflow = document.documentElement.style.overflow
  pageLocked = true
  document.documentElement.style.overflow = 'hidden'
  pageRoot = document.getElementById('__nuxt')
  previousInert = pageRoot?.inert ?? false
  if (pageRoot) pageRoot.inert = true
  const instance = new PhotoSwipe({
    dataSource: props.slides, index: props.index, mainClass: 'xvyin-photo-lightbox',
    ...photoLightboxMotion(motion.matches), bgOpacity: 1, preload: [1, 1],
    trapFocus: true, returnFocus: false, escKey: true, arrowKeys: true,
    closeTitle: '关闭照片', zoomTitle: '放大或缩小照片', arrowPrevTitle: '上一张照片', arrowNextTitle: '下一张照片',
    errorMsg: '照片暂时无法显示，请重试或切换到其他照片。',
    clickToCloseNonZoomable: false, imageClickAction: 'zoom', tapAction: 'toggle-controls',
    paddingFn: ({ x, y }) => ({ top: 64, bottom: Math.min(240, Math.round(y * .3)) + 12, left: x < 600 ? 12 : 64, right: x < 600 ? 12 : 64 }),
  })
  viewer = instance
  // PhotoSwipe ignores close/destroy while its opening transition is in flight.
  // Finish cleanup after event binding if navigation unmounted us in that interval.
  instance.on('openingAnimationEnd', () => { if (disposed) queueMicrotask(() => instance.destroy()) })
  instance.on('uiRegister', () => instance.ui?.registerElement({
    name: 'photo-caption', appendTo: 'root', order: 9,
    onInit: (element) => { captionHost.value = element },
  }))
  instance.on('change', () => {
    current.value = instance.currIndex
    imageFailed.value = Boolean(instance.currSlide?.content.isError())
    announcePhoto()
  })
  instance.on('loadComplete', ({ content }) => {
    if (content.index === instance.currIndex) imageFailed.value = content.isError()
  })
  instance.on('afterInit', () => {
    instance.element?.setAttribute('aria-modal', 'true')
    instance.element?.setAttribute('aria-label', '查看照片')
    instance.element?.setAttribute('aria-describedby', captionId)
  })
  // PhotoSwipe's focusin guard does not catch Tab moving into browser chrome.
  // Cycle the actual visible controls, including the Vue-rendered caption.
  instance.on('keydown', event => {
    const key = event.originalEvent
    if (key.key !== 'Tab' || !instance.element) return
    instance.element.classList.add('pswp--ui-visible')
    const controls = [...instance.element.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])')]
      .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[aria-hidden="true"], [inert]'))
    const focused = controls.indexOf(document.activeElement as HTMLElement)
    const next = key.shiftKey ? (focused <= 0 ? controls.length - 1 : focused - 1) : (focused + 1) % controls.length
    key.preventDefault(); event.preventDefault()
    ;(controls[next] || instance.element).focus({ preventScroll: true })
  })
  instance.on('destroy', () => {
    restorePage()
    motion?.removeEventListener('change', applyMotion)
    if (props.albumId || props.photoContexts) window.dispatchEvent(new CustomEvent('xvyin-photo-view'))
    viewer = undefined
    if (!disposed) {
      if (props.trigger.isConnected) props.trigger.focus({ preventScroll: true })
      emit('close')
    }
  })
  motion.addEventListener('change', applyMotion)
  instance.init()
})
onBeforeUnmount(() => {
  disposed = true
  motion?.removeEventListener('change', applyMotion)
  if (viewer?.element) viewer.element.style.display = 'none'
  viewer?.destroy()
  restorePage()
})
</script>

<template>
  <Teleport v-if="captionHost && photo" :to="captionHost">
    <div :id="captionId" class="photo-viewer-caption" @pointerdown.stop @pointermove.stop @pointerup.stop @wheel.stop>
      <p class="photo-viewer-position" aria-live="polite" aria-atomic="true">{{ current + 1 }} / {{ slides.length }} · {{ photo.title || photo.alt || '照片' }}</p>
      <p v-if="photo.caption" class="photo-viewer-description">{{ photo.caption }}</p>
      <time v-if="photo.photoDate" :datetime="photo.photoDate">{{ displayDate(photo.photoDate) }}</time>
      <PhotoMetadata :key="photo.assetId" :asset-id="photo.assetId" :hide-date="Boolean(photo.photoDate)" expanded />
      <div class="photo-viewer-actions">
        <LikeButton v-if="target" :key="`${target.parentId}/${target.id}`" :target="target" :label="photo.alt" />
        <NuxtLink v-if="context" :to="`/photography/${encodeURIComponent(context.albumSlug)}`">走进「{{ context.albumTitle }}」</NuxtLink>
        <button v-if="imageFailed" type="button" @click="retry">重新加载照片</button>
      </div>
    </div>
  </Teleport>
</template>

<style>
.xvyin-photo-lightbox{--pswp-bg:var(--paper,#f7f3e9);--pswp-icon-color:var(--ink,#282821);--pswp-icon-color-secondary:var(--paper,#f7f3e9);--pswp-icon-stroke-color:transparent;--pswp-icon-stroke-width:0;--pswp-error-text-color:var(--ink,#282821);color:var(--ink,#282821);z-index:1200;font-family:var(--sans,serif)}
.xvyin-photo-lightbox .pswp__button{min-height:50px;min-width:50px;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none}
.xvyin-photo-lightbox .pswp__button:hover{background:var(--soft,#eee9df)}
.xvyin-photo-lightbox .pswp__button:focus-visible{outline:2px solid var(--red,#9e3e30);outline-offset:-5px}
.xvyin-photo-lightbox .pswp__counter{color:var(--ink,#282821);text-shadow:none}
.xvyin-photo-lightbox .pswp__top-bar{height:60px;border-bottom:1px solid var(--line,#dbd6cb);background:var(--paper,#f7f3e9)}
.xvyin-photo-lightbox .pswp__img{max-width:none;object-fit:contain}
.xvyin-photo-lightbox .pswp__photo-caption{position:absolute;bottom:0;left:0;width:100%;height:min(30vh,240px);height:min(30dvh,240px);padding:0 max(20px,env(safe-area-inset-right)) env(safe-area-inset-bottom) max(20px,env(safe-area-inset-left));overflow:auto;overscroll-behavior:contain;background:var(--paper,#f7f3e9);transition:opacity .18s}
.xvyin-photo-lightbox .photo-viewer-caption{max-width:960px;margin:0 auto;padding:12px 0 16px;border-top:1px solid var(--line,#dbd6cb);font-size:14px;line-height:1.65;touch-action:pan-y;overflow-wrap:anywhere}
.xvyin-photo-lightbox .photo-viewer-position{font-family:var(--serif,serif);font-size:18px;margin:0 0 6px}
.xvyin-photo-lightbox .photo-viewer-description{margin:4px 0}.xvyin-photo-lightbox time{font-size:12px;color:var(--muted,#68685e)}
.xvyin-photo-lightbox .photo-viewer-actions{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:8px}
.xvyin-photo-lightbox .photo-viewer-actions button{font-size:13px;min-height:40px;padding:6px 12px}
.xvyin-photo-lightbox:not(.pswp--ui-visible) .pswp__photo-caption{opacity:0;pointer-events:none}
@media(max-width:600px){.xvyin-photo-lightbox .photo-viewer-caption{font-size:13px}.xvyin-photo-lightbox .photo-viewer-position{font-size:16px}}
@media(prefers-reduced-motion:reduce){.xvyin-photo-lightbox,.xvyin-photo-lightbox *{transition-duration:0s!important;animation-duration:0s!important;scroll-behavior:auto!important}}
</style>
