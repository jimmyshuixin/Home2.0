<script setup lang="ts">
import { site, displayDate, formatLabel } from '~/lib/site'
import { richTextOutline } from '~/lib/richtext-outline'
const route = useRoute()
const entry = computed(() => site.creations.find((item) => item.slug === route.params.slug))
if (!entry.value) throw createError({ statusCode: 404, statusMessage: 'Creation not found' })
const toc = computed(() => richTextOutline(entry.value!.blocks))
const related = computed(() => site.creations.filter((item) => item.id !== entry.value!.id && item.tags.some((tag) => entry.value!.tags.includes(tag))).slice(0, 2))
usePublicationSeo(() => entry.value, 'creation')
</script>
<template><div v-if="entry" class="reading-page"><NuxtLink class="crumb" to="/creations"><SiteIcon name="back" />返回创作</NuxtLink><header class="article-head"><h1>{{ entry.title }}</h1><p class="summary">{{ entry.summary }}</p><div class="article-meta"><span v-if="entry.tags.length">{{ entry.tags.join(' / ') }}</span><span>{{ formatLabel(entry) }}</span><time v-if="entry.publishedAt" :datetime="entry.publishedAt">{{ displayDate(entry.publishedAt) }}</time></div></header><div class="article-layout reading-layout" :class="{ 'has-toc': toc.length }"><article class="prose reading-body"><details v-if="toc.length" class="mobile-toc disclosure"><summary>本文目录</summary><nav><a v-for="item in toc" :key="item.id" :data-level="item.level" :href="`#${item.id}`">{{ item.label }}</a><a href="#comments">聊聊这篇创作</a></nav></details><ContentBlocks :blocks="entry.blocks" /><div class="creation-appreciation"><LikeButton :target="{type: 'creation', id: entry.id}" :label="entry.title" /></div><TopicBacklinks :member="{collection: 'creations', id: entry.id}"/><section v-if="related.length" class="related"><h2>继续看看</h2><CreationCard v-for="item in related" :key="item.id" :entry="item" /></section><section id="comments" class="comments"><h2>聊聊这篇创作<span class="dot" aria-hidden="true" /></h2><CommentList target-type="creation" :target-id="entry.id" /><CommentForm target-type="creation" :target-id="entry.id" /></section></article><aside v-if="toc.length" class="toc"><h2>本文目录</h2><a v-for="item in toc" :key="item.id" :data-level="item.level" :href="`#${item.id}`">{{ item.label }}</a><a href="#comments">聊聊这篇创作</a></aside></div></div></template>

<style scoped>.creation-appreciation{margin:32px 0 44px;display:flex;justify-content:center}</style>
