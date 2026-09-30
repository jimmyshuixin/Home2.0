<script setup lang="ts">
import type { ContentBlock } from '@xvyin/contracts'
import { assetVariant, displayDate, ordered, type Photo } from '~/lib/site'
const props = defineProps<{ photos: Photo[]; title: string }>()
const comparisonOpen = ref(false)
const photos = computed(() => ordered(props.photos))
const first = ref(0), second = ref(1)
const comparisonVariant = (id: string) => ['content', 'large', 'thumb'].map(role => assetVariant(id, role)).find(variant => variant?.mime.startsWith('image/') && variant.width && variant.height)
const pair = computed(() => {
  const before = photos.value[first.value], after = photos.value[second.value]
  if (!before || !after) return null
  const side = (photo: Photo, index: number) => ({ assetId: photo.assetId, alt: photo.alt, label: photo.photoDate ? displayDate(photo.photoDate) : `影像 ${index + 1}` })
  const block: Extract<ContentBlock, { type: 'compare' }> = { id: 'fitness-comparison', type: 'compare', before: side(before, first.value), after: side(after, second.value), mode: 'side-by-side', caption: '所选影像的对照。拍摄角度与光线可能不同，可并排查看。' }
  return { block, beforeImage: comparisonVariant(before.assetId), afterImage: comparisonVariant(after.assetId) }
})
</script>

<template>
  <div class="fitness-photo-pair">
    <div v-if="photos.length >= 2" class="pair-toolbar" role="group" :aria-label="`${title}的影像查看方式`"><button :aria-pressed="!comparisonOpen" @click="comparisonOpen = false">浏览照片</button><button :aria-pressed="comparisonOpen" @click="comparisonOpen = true">前后对照</button></div>
    <template v-if="comparisonOpen && pair">
      <div v-if="photos.length > 2" class="pair-selectors"><label>第一张<select v-model.number="first"><option v-for="(photo, index) in photos" :key="photo.assetId + index" :value="index" :disabled="index === second">{{ index + 1 }} · {{ photo.photoDate ? displayDate(photo.photoDate) : photo.alt }}</option></select></label><label>第二张<select v-model.number="second"><option v-for="(photo, index) in photos" :key="photo.assetId + index" :value="index" :disabled="index === first">{{ index + 1 }} · {{ photo.photoDate ? displayDate(photo.photoDate) : photo.alt }}</option></select></label></div>
      <ImageComparison :block="pair.block" :before-image="pair.beforeImage" :after-image="pair.afterImage" />
    </template>
    <PhotoGallery v-else :photos="photos" layout="grid" />
  </div>
</template>

<style scoped>
.fitness-photo-pair{min-width:0}.pair-toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}.pair-toolbar button{font-size:12px;min-height:42px;padding:8px 14px}.pair-toolbar button[aria-pressed=true]{color:var(--paper,#f7f3e9);background:var(--green);border-color:var(--green)}.pair-selectors{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-bottom:18px}.pair-selectors label{font-size:12px;color:var(--muted)}.pair-selectors select{display:block;max-width:100%;width:100%;margin-top:7px;min-height:42px;background:transparent;border:1px solid var(--line);color:var(--ink);padding:8px}@media(max-width:500px){.pair-selectors{grid-template-columns:minmax(0,1fr)}}
</style>
