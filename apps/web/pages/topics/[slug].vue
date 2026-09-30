<script setup lang="ts">
import { site, assetVariant, assetSrcSet } from '~/lib/site'
import { topicEntries } from '~/lib/topics'
import { sharingImage } from '~/lib/publication-metadata'
const route = useRoute(), config = useRuntimeConfig()
const topic = computed(() => site.settings.topics?.find(item => item.slug === route.params.slug))
if (!topic.value) throw createError({ statusCode: 404, statusMessage: 'Topic not found' })
const entries = computed(() => topic.value ? topicEntries(topic.value, site) : [])
const coverAssetId = computed(() => entries.value.find(entry => entry.coverAssetId)?.coverAssetId)
const origin = String(config.public.publicOrigin)
const image = computed(() => sharingImage(site.assets, [coverAssetId.value], origin))
useSeoMeta({ title: () => `${topic.value?.title || ''} · 专题 · 虚宁`, description: () => topic.value?.intro,
  ogTitle: () => topic.value?.title, ogDescription: () => topic.value?.intro, ogType: 'website', ogImage: () => image.value.url,
  twitterCard: 'summary_large_image', twitterTitle: () => topic.value?.title, twitterDescription: () => topic.value?.intro, twitterImage: () => image.value.url })
useHead(() => ({ script: topic.value ? [{ key: 'topic-jsonld', type: 'application/ld+json', innerHTML: JSON.stringify({
  '@context': 'https://schema.org', '@type': 'CollectionPage', name: topic.value.title, description: topic.value.intro, url: `${origin}/topics/${topic.value.slug}`,
  mainEntity: { '@type': 'ItemList', itemListElement: entries.value.map((entry, index) => ({ '@type': 'ListItem', position: index + 1, name: entry.title, url: `${origin}${entry.href}` })) },
}).replace(/</gu, '\\u003c') }] : [] }))
</script>

<template>
  <div v-if="topic" class="topic-page"><NuxtLink class="crumb" to="/topics"><SiteIcon name="back" />全部专题</NuxtLink>
    <header class="article-head"><p class="topic-kicker">专题 · {{ entries.length }} 项内容</p><h1>{{ topic.title }}</h1><p v-if="topic.intro" class="summary topic-intro">{{ topic.intro }}</p></header>
    <figure v-if="coverAssetId" class="topic-hero"><img :src="assetVariant(coverAssetId)?.url" :srcset="assetSrcSet(coverAssetId)" sizes="(max-width: 900px) calc(100vw - 48px), 900px" :width="assetVariant(coverAssetId)?.width" :height="assetVariant(coverAssetId)?.height" alt="" decoding="async"></figure>
    <ol class="topic-reading-list" aria-label="专题阅读顺序"><li v-for="(entry, index) in entries" :key="`${entry.collection}/${entry.id}`"><span class="topic-order" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span><div class="topic-entry"><p class="topic-kind">{{ entry.label }}</p><h2><NuxtLink :to="entry.href">{{ entry.title }}</NuxtLink></h2><p v-if="entry.summary" class="topic-description">{{ entry.summary }}</p><NuxtLink class="text-link" :to="entry.href">{{ entry.collection === 'albums' ? '浏览相册' : '阅读创作' }}<SiteIcon name="arrow" :size="18" /></NuxtLink></div><NuxtLink v-if="entry.coverAssetId" class="topic-thumbnail" :to="entry.href" tabindex="-1" aria-hidden="true"><img :src="assetVariant(entry.coverAssetId, 'thumb')?.url" :width="assetVariant(entry.coverAssetId, 'thumb')?.width" :height="assetVariant(entry.coverAssetId, 'thumb')?.height" alt="" loading="lazy" decoding="async"></NuxtLink></li></ol>
  </div>
</template>

<style scoped>
.topic-page{max-width:960px;margin:0 auto}.topic-kicker{font-size:12px;letter-spacing:.08em;color:var(--muted);margin-bottom:16px}.topic-intro{white-space:pre-line}.topic-hero{margin:0 0 56px}.topic-hero img{display:block;width:100%;height:auto;max-height:620px;object-fit:contain}.topic-reading-list{padding:0;margin:0;list-style:none}.topic-reading-list>li{display:flex;gap:clamp(20px,4vw,40px);padding:36px 0;border-top:1px solid var(--line)}.topic-order{font-size:22px;color:var(--muted);font-variant-numeric:tabular-nums;flex-shrink:0}.topic-entry{flex:1;min-width:0}.topic-kind{font-size:11px;color:var(--muted);margin:0 0 10px;letter-spacing:.1em}.topic-entry h2{font-size:clamp(22px,3vw,28px);line-height:1.5;margin:0 0 16px;overflow-wrap:anywhere}.topic-description{color:var(--muted);line-height:1.85;margin:0 0 20px;overflow-wrap:anywhere}.topic-thumbnail{width:140px;flex-shrink:0;align-self:flex-start}.topic-thumbnail img{display:block;width:100%;height:120px;object-fit:cover}@media(max-width:620px){.topic-reading-list>li{flex-wrap:wrap;padding:28px 0}.topic-thumbnail{margin-left:46px;width:calc(100% - 46px)}.topic-thumbnail img{height:auto;max-height:220px}.topic-order{font-size:18px}.topic-hero{margin-bottom:32px}}
</style>
