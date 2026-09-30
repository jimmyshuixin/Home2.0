<script setup lang="ts">
import { site } from '~/lib/site'
import { publishedNotes, visibleNow, noteDate } from '~/lib/notes'
const notes = publishedNotes(site.creations).slice(0, 2)
const now = visibleNow(site.settings)
const topic = site.settings.topics?.[0]
const paths = [
  { href: '/notes', title: '随记', detail: '零散的文字与影像' },
  { href: '/now', title: '近况', detail: '最近在做的事' },
  { href: '/topics', title: '专题', detail: '沿着线索，读一组作品' },
  { href: '/yearbook', title: '年鉴', detail: '循着年月，重看日常' },
]
</script>

<template>
  <section class="section journal-overview" aria-labelledby="journal-overview-heading">
    <div class="section-heading"><h2 id="journal-overview-heading">日常的几种读法<span class="dot" aria-hidden="true" /></h2></div>
    <nav class="journal-paths" aria-label="日常与回顾">
      <NuxtLink v-for="path in paths" :key="path.href" :to="path.href"><span>{{ path.title }}<SiteIcon name="arrow" :size="17" /></span><small>{{ path.detail }}</small></NuxtLink>
    </nav>
    <div v-if="now || topic" class="journal-highlights">
      <article v-if="now" class="journal-now"><p class="small muted">近况 · 更新于 {{ noteDate(now.updatedAt!) }}</p><p class="journal-now-text">{{ now.text }}</p><NuxtLink class="text-link" to="/now">读近况<SiteIcon name="arrow" :size="16" /></NuxtLink></article>
      <article v-if="topic" class="journal-topic"><p class="small muted">沿着一条线索</p><h3><NuxtLink :to="`/topics/${topic.slug}`">{{ topic.title }}</NuxtLink></h3><p>{{ topic.intro }}</p><NuxtLink class="text-link" :to="`/topics/${topic.slug}`">展开专题<SiteIcon name="arrow" :size="16" /></NuxtLink></article>
    </div>
    <div v-if="notes.length" class="journal-notes"><NoteCard v-for="entry in notes" :key="entry.id" :entry="entry" compact /></div>
  </section>
</template>

<style scoped>
.journal-paths{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:28px;border-block:1px solid var(--line);padding:24px 0}.journal-paths>a{min-width:0;min-height:72px;text-decoration:none;display:flex;flex-direction:column;justify-content:center;gap:10px}.journal-paths>a>span{display:flex;align-items:center;justify-content:space-between;font-size:23px;color:var(--green);gap:12px}.journal-paths small{font-size:12px;color:var(--muted);line-height:1.8}.journal-highlights{display:flex;flex-wrap:wrap;gap:36px;margin-top:28px}.journal-highlights>article{flex:1 1 300px;min-width:0}.journal-highlights h3{font-size:27px;margin:10px 0 14px}.journal-highlights p{line-height:1.9;overflow-wrap:anywhere}.journal-highlights .small{font-size:12px}.journal-topic>p:not(.small){color:var(--muted)}.journal-now-text{white-space:pre-line;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}.journal-notes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:40px}.journal-paths a:focus-visible{outline:2px solid var(--green);outline-offset:6px}@media(max-width:640px){.journal-paths{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 24px;padding:18px 0}.journal-paths>a>span{font-size:22px}.journal-paths>a{min-height:78px}.journal-highlights{gap:20px}.journal-notes{grid-template-columns:minmax(0,1fr);gap:0}}
</style>
