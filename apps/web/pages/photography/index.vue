<script setup lang="ts">
import { site, assetVariant, assetSrcSet, ordered } from '~/lib/site'
const albums = ordered(site.albums).map((album) => ({
  ...album,
  cover: assetVariant(album.coverAssetId || album.photos[0]?.assetId)
}))
useSeoMeta({ title: '摄影 · 虚宁', description: '用镜头，收藏片刻。' })
</script>
<template>
  <section class="page-heading">
    <h1>用镜头，收藏片刻<span class="dot" aria-hidden="true" /></h1>
    <p>一些光线，一些经过的地方。</p>
  </section>
  <div v-if="albums.length" class="album-list">
    <article v-for="album in albums" :key="album.id" class="album-card">
      <NuxtLink :to="`/photography/${album.slug}`">
        <span v-if="album.cover" class="album-cover" :style="{ '--album-cover-ratio': `${album.cover.width || 3} / ${album.cover.height || 2}` }">
          <img
            :src="album.cover.url"
            :srcset="assetSrcSet(album.coverAssetId || album.photos[0]?.assetId)"
            sizes="(max-width: 760px) calc(100vw - 66px), 540px"
            decoding="async"
            :alt="album.title"
            :width="album.cover.width"
            :height="album.cover.height"
            loading="lazy"
          >
        </span>
        <h2>{{ album.title }}</h2>
      </NuxtLink>
      <p v-if="album.description">{{ album.description }}</p>
      <NuxtLink class="text-link" :to="`/photography/${album.slug}`">打开这个系列<SiteIcon name="arrow" :size="18" /></NuxtLink>
    </article>
  </div>
  <div v-else class="empty-state">
    <h2>还没有公开摄影系列</h2>
    <p>影像正在整理，准备好后会出现在这里。</p>
    <NuxtLink class="text-link" to="/creations">先看看创作<SiteIcon name="arrow" /></NuxtLink>
  </div>
</template>
