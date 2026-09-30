<script setup lang="ts">
import { assetVariant, assetSrcSet, displayDate, ordered, type Photo } from '~/lib/site'
import type { Component } from 'vue'
import { photoLightboxSlides, photoViewerArbiter, photoViewerTarget, type PhotoContext, type PhotoSlide, type PhotoViewerLease } from '~/lib/photo-lightbox'
const props = withDefaults(defineProps<{ photos: Photo[]; layout?: string; albumId?: string; photoContexts?: Record<string, PhotoContext> }>(), { layout: 'grid' })
const pictures = computed(() => ordered(props.photos))
const contextFor = (photo: Photo) => props.photoContexts?.[photo.id || photo.assetId]
const targetFor = (photo: Photo) => photoViewerTarget(photo, props.albumId, props.photoContexts)
const continuous = computed(() => ['continuous', 'stack'].includes(props.layout) || pictures.value.length === 1)
function portrait(item: Photo) { const variant = assetVariant(item.assetId); return Boolean(variant?.width && variant?.height && variant.height > variant.width * 1.1) }
const imageSizes = computed(() => continuous.value ? '(max-width: 600px) calc(100vw - 40px), (max-width: 1000px) calc(100vw - 80px), 960px' : '(max-width: 600px) calc(100vw - 40px), (max-width: 1000px) calc((100vw - 80px) / 2), 560px')
const failed = ref<Record<string, boolean>>({})
const lightbox = shallowRef<Component>(), opening = ref(false), openError = ref('')
const request = shallowRef<{ photos: Photo[]; slides: PhotoSlide[]; index: number; trigger: HTMLElement }>()
let viewerLease: PhotoViewerLease | undefined
function closeViewer() { request.value = undefined; opening.value = false; viewerLease?.release(); viewerLease = undefined }
async function show(photoIndex: number, event: MouseEvent) {
  const lease = photoViewerArbiter().request(() => { if (viewerLease === lease) closeViewer() })
  if (!lease) return
  viewerLease = lease
  const trigger = event.currentTarget as HTMLElement, photos = pictures.value
  const slides = photoLightboxSlides(photos, id => assetVariant(id, 'large'), assetSrcSet)
  const index = slides.findIndex(slide => slide.photoIndex === photoIndex)
  openError.value = ''
  if (index < 0) { openError.value = '这张照片的尺寸暂不可用，请稍后再试。'; closeViewer(); return }
  opening.value = true
  try {
    const component = lightbox.value || (await import('./PhotoLightbox.vue')).default
    if (!lease.markOpen()) return
    lightbox.value = component
    request.value = { photos, slides, index, trigger }
  } catch {
    if (lease.isCurrent()) { openError.value = '照片查看器暂时无法加载，请刷新页面后重试。'; closeViewer() }
  } finally { if (lease.isCurrent()) opening.value = false }
}
onBeforeUnmount(closeViewer)
</script>

<style scoped>
.photo-appreciation{margin-top:8px}.gallery-frame{align-items:start;gap:clamp(24px,3vw,40px) clamp(16px,2.5vw,28px);width:100%;min-width:0}.gallery-frame figure{margin:0;min-width:0;align-self:start}.gallery-frame .photo-button{height:auto;max-height:none;min-height:0;display:block;background:transparent!important;line-height:0;overflow:hidden}.gallery-frame img{width:100%;height:auto;max-height:680px;max-height:min(78svh,760px);object-fit:contain;object-position:center;display:block}.gallery-frame.photo-gallery-continuous{max-width:none}.gallery-frame.photo-gallery-continuous .portrait-photo{width:min(100%,480px);justify-self:center}.gallery-frame .photo-button:hover img{opacity:.94}.gallery-frame figcaption{margin:12px auto 0;text-align:left;line-height:1.75;max-width:42rem;overflow-wrap:anywhere}.gallery-frame figcaption strong{font-size:18px;font-weight:400}.gallery-frame figcaption time{font-size:12px;margin-top:5px;font-variant-numeric:tabular-nums}.gallery-frame .expand-icon{width:34px;height:34px;right:10px;top:10px;opacity:0;transition:opacity .15s}.gallery-frame .photo-button:is(:hover,:focus-visible) .expand-icon{opacity:1}.gallery-frame.gallery-columns{display:block;columns:2;column-gap:24px}.gallery-columns figure{break-inside:avoid;margin-bottom:30px}.gallery-columns img{max-height:none}.gallery-frame .media-unavailable{min-height:180px;display:grid;place-content:center}.lightbox-body>img{background:transparent;object-fit:contain}.lightbox-caption{max-width:42rem;margin-inline:auto}
@media(hover:none){.gallery-frame .expand-icon{opacity:.8}}
@media(max-width:600px){.gallery-frame:not(.photo-gallery-continuous){grid-template-columns:minmax(0,1fr)}.gallery-frame.gallery-columns{columns:1}.gallery-frame img{max-height:78svh}.gallery-frame figcaption{font-size:13px;margin-top:10px}.gallery-frame.photo-gallery-continuous .portrait-photo{width:min(100%,440px)}}
</style>
<template>
  <div :class="['photo-gallery', 'gallery-frame', { 'photo-gallery-continuous': continuous, 'gallery-columns': layout === 'columns' }]">
    <figure v-for="(item, i) in pictures" :key="item.id || `${item.assetId}/${i}`" :class="{ 'portrait-photo': portrait(item) }">
      <button v-if="assetVariant(item.assetId) && !failed[item.assetId]" class="photo-button" :aria-label="`放大查看${item.title || item.alt || '照片'}`" :aria-busy="opening || undefined" @click="show(i, $event)">
        <img :src="assetVariant(item.assetId)?.url" :srcset="assetSrcSet(item.assetId)" :sizes="portrait(item) ? '(max-width: 600px) calc(100vw - 40px), 440px' : imageSizes" :width="assetVariant(item.assetId)?.width" :height="assetVariant(item.assetId)?.height" :alt="item.alt" loading="lazy" decoding="async" @error="failed[item.assetId] = true">
        <span class="expand-icon"><SiteIcon name="expand" /></span>
      </button>
      <div v-else class="media-unavailable"><p>照片暂时无法显示。</p><button v-if="failed[item.assetId]" @click="failed[item.assetId] = false">重新加载</button></div>
      <figcaption v-if="item.title || item.caption || item.photoDate"><strong v-if="item.title">{{ item.title }}</strong><span v-if="item.caption">{{ item.caption }}</span><time v-if="item.photoDate" :datetime="item.photoDate">{{ displayDate(item.photoDate) }}</time></figcaption>
      <PhotoMetadata :asset-id="item.assetId" :hide-date="Boolean(item.photoDate)" />
      <NuxtLink v-if="contextFor(item)" class="photo-source-album" :to="`/photography/${encodeURIComponent(contextFor(item)!.albumSlug)}`">来自「{{ contextFor(item)!.albumTitle }}」<SiteIcon name="arrow" :size="13" /></NuxtLink>
      <div v-if="targetFor(item)" class="photo-appreciation"><LikeButton :load-count="false" :target="targetFor(item)!" :label="item.alt" /></div>
    </figure>
  </div>
  <p v-if="opening" role="status">正在打开照片… <button type="button" @click="closeViewer">取消</button></p><p v-if="openError" role="alert">{{ openError }}</p>
  <component :is="lightbox" v-if="lightbox && request" v-bind="request" :album-id="albumId" :photo-contexts="photoContexts" @close="closeViewer" />
</template>
<style scoped>
.photo-source-album{display:inline-flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;line-height:1.8;color:var(--green);text-decoration:none;overflow-wrap:anywhere}.photo-source-album:hover{text-decoration:underline;text-underline-offset:4px}.photo-source-album:focus-visible{outline:2px solid var(--green);outline-offset:4px}.photo-source-album svg{flex-shrink:0}
</style>
