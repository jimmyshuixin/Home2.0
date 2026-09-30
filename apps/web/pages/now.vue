<script setup lang="ts">
import { site } from '~/lib/site';
import { noteDate, visibleNow } from '~/lib/notes';
const now = visibleNow(site.settings);
useSeoMeta({ title: '近况 · 虚宁', description: now?.text.slice(0, 160) || '最近在做、在读、在练的事情。' });
</script>
<template>
  <section class="page-heading"><h1>近况<span class="dot" aria-hidden="true" /></h1><p>最近在做、在读、在练的事情。</p></section>
  <article v-if="now" class="now-paper"><p class="small muted">更新于 <time :datetime="now.updatedAt!">{{ noteDate(now.updatedAt!) }}</time></p><div class="now-text prose">{{ now.text }}</div></article>
  <div v-else class="empty-state"><h2>近况暂无更新</h2><p>有新的近况时，会写在这里。</p></div>
  <div class="now-links"><NuxtLink class="text-link" to="/notes">翻一翻随记<SiteIcon name="arrow" :size="16" /></NuxtLink><NuxtLink class="text-link" to="/about">更多关于我<SiteIcon name="arrow" :size="16" /></NuxtLink></div>
</template>
<style scoped>
.now-paper{max-width:720px;margin:0 auto;padding:32px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.now-text{margin-top:26px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:18px;line-height:2}.now-links{display:flex;justify-content:center;gap:32px;flex-wrap:wrap;margin:32px 0}@media(max-width:600px){.now-paper{padding:24px 0}.now-text{font-size:16px}.now-links{gap:24px}}
</style>
