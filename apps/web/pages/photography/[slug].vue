<script setup lang="ts">
import { site } from '~/lib/site'
const route = useRoute()
const album = computed(() => site.albums.find((item) => item.slug === route.params.slug))
if (!album.value) throw createError({ statusCode: 404, statusMessage: 'Album not found' })
const layout = ref('grid')
useSeoMeta({ title: () => `${album.value?.title} · 摄影 · 虚宁`, description: () => album.value?.description })
</script>
<template><template v-if="album"><NuxtLink class="crumb" to="/photography"><SiteIcon name="back" />全部摄影</NuxtLink><header class="article-head"><h1>{{ album.title }}</h1><p v-if="album.description" class="summary">{{ album.description }}</p></header><div class="filters" role="group" aria-label="照片布局"><button :aria-pressed="layout === 'grid'" @click="layout = 'grid'">网格浏览</button><button :aria-pressed="layout === 'continuous'" @click="layout = 'continuous'">连续大图</button></div><PhotoGallery v-if="album.photos.length" :photos="album.photos" :layout="layout" /><div v-else class="empty-state"><p>这个系列暂时没有公开照片。</p></div><section class="comments prose"><h2>聊聊这个系列<span class="dot" aria-hidden="true" /></h2><CommentList target-type="album" :target-id="album.id" /><CommentForm target-type="album" :target-id="album.id" /></section></template></template>
