<script setup lang="ts">
import { site, assetVariant, assetSrcSet } from '~/lib/site'
import { topicEntries } from '~/lib/topics'
const topics = (site.settings.topics || []).map(topic => {
  const entries = topicEntries(topic, site)
  return { ...topic, entries, coverAssetId: entries.find(entry => entry.coverAssetId)?.coverAssetId }
})
useSeoMeta({ title: '专题 · 虚宁', description: '把文字、影像与片刻，编成有序的篇章。' })
</script>

<template>
  <section class="page-heading"><h1>把片刻，编成篇章<span class="dot" aria-hidden="true" /></h1><p>一些文字，一些影像，沿着同一条线索慢慢展开。</p></section>
  <div v-if="topics.length" class="topic-grid">
    <article v-for="(topic, index) in topics" :key="topic.id" class="topic-card">
      <NuxtLink v-if="topic.coverAssetId" :to="`/topics/${topic.slug}`" class="topic-cover" aria-hidden="true" tabindex="-1"><img :src="assetVariant(topic.coverAssetId)?.url" :srcset="assetSrcSet(topic.coverAssetId)" sizes="(max-width: 700px) calc(100vw - 48px), 48vw" :width="assetVariant(topic.coverAssetId)?.width" :height="assetVariant(topic.coverAssetId)?.height" alt="" loading="lazy" decoding="async"></NuxtLink>
      <p class="topic-number">{{ String(index + 1).padStart(2, '0') }}<span>{{ topic.entries.length }} 项内容</span></p>
      <h2><NuxtLink :to="`/topics/${topic.slug}`">{{ topic.title }}</NuxtLink></h2><p v-if="topic.intro" class="topic-intro">{{ topic.intro }}</p><NuxtLink class="text-link" :to="`/topics/${topic.slug}`">展开专题<SiteIcon name="arrow" :size="18" /></NuxtLink>
    </article>
  </div>
  <div v-else class="empty-state"><p>还没有整理好的专题。</p><NuxtLink class="text-link" to="/creations">先看看创作<SiteIcon name="arrow" :size="18" /></NuxtLink></div>
</template>

<style scoped>
.topic-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:56px 40px}.topic-card{min-width:0}.topic-cover{display:block;aspect-ratio:3/2;overflow:hidden;margin-bottom:24px;background:var(--line)}.topic-cover img{width:100%;height:100%;object-fit:cover}.topic-number{display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--muted);letter-spacing:.08em;margin:0 0 14px}.topic-number>span{font-size:11px;letter-spacing:0}.topic-card h2{font-size:clamp(24px,3vw,32px);margin:0 0 16px;line-height:1.45;overflow-wrap:anywhere}.topic-intro{white-space:pre-line;color:var(--muted);line-height:1.9;margin-bottom:24px;overflow-wrap:anywhere}@media(max-width:700px){.topic-grid{grid-template-columns:1fr;gap:44px}}
</style>
