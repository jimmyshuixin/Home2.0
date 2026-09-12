<script setup lang="ts">
import { assetVariant, displayDate, ordered, type Photo } from '~/lib/site'
const props = withDefaults(defineProps<{ photos: Photo[]; layout?: string }>(), { layout: 'grid' })
const pictures = computed(() => ordered(props.photos)), open = ref(false), active = ref(0)
const photo = computed(() => pictures.value[active.value])
const large = computed(() => assetVariant(photo.value?.assetId, 'large'))
const failed = ref<Record<string, boolean>>({})
function show(i: number) { active.value = i; open.value = true }
function navigate(delta: number) { active.value = (active.value + delta + pictures.value.length) % pictures.value.length }
function keyboard(event: KeyboardEvent) { if (!open.value) return; if (event.key === 'ArrowLeft') navigate(-1); if (event.key === 'ArrowRight') navigate(1) }
onMounted(() => window.addEventListener('keydown', keyboard))
onBeforeUnmount(() => window.removeEventListener('keydown', keyboard))
</script>
<template><div :class="['photo-gallery', { 'photo-gallery-continuous': layout === 'continuous' }]"><figure v-for="(item, i) in pictures" :key="item.id || item.assetId"><button v-if="assetVariant(item.assetId) && !failed[item.assetId]" class="photo-button" :aria-label="`放大查看${item.title || item.alt || '照片'}`" @click="show(i)"><img :src="assetVariant(item.assetId)?.url" :width="assetVariant(item.assetId)?.width" :height="assetVariant(item.assetId)?.height" :alt="item.alt" loading="lazy" decoding="async" @error="failed[item.assetId] = true"><span class="expand-icon"><SiteIcon name="expand" /></span></button><div v-else class="media-unavailable"><p>照片暂时无法显示。</p><button v-if="failed[item.assetId]" @click="failed[item.assetId] = false">重新加载</button></div><figcaption><strong v-if="item.title">{{ item.title }}</strong><span v-if="item.caption">{{ item.caption }}</span><time v-if="item.photoDate" :datetime="item.photoDate">{{ displayDate(item.photoDate) }}</time></figcaption></figure></div><AppDialog v-model="open" :title="photo?.title || '查看照片'" wide><div v-if="photo" class="lightbox-body"><img v-if="large" :src="large.url" :alt="photo.alt" :width="large.width" :height="large.height"><p v-else>照片暂时无法显示。</p><div class="lightbox-caption"><p v-if="photo.caption">{{ photo.caption }}</p><time v-if="photo.photoDate" :datetime="photo.photoDate">{{ displayDate(photo.photoDate) }}</time></div></div><div v-if="pictures.length > 1" class="lightbox-nav"><button aria-label="上一张照片" @click="navigate(-1)"><SiteIcon name="back" />上一张</button><span>{{ active + 1 }} / {{ pictures.length }}</span><button aria-label="下一张照片" @click="navigate(1)">下一张<SiteIcon name="arrow" /></button></div></AppDialog></template>
