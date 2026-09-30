<script setup lang="ts">
import { site } from '~/lib/site'
useSeoMeta({ title: '站内搜索 · 虚宁', description: '在虚宁的创作、摄影与公开日常中寻找文字和风景。', robots: 'noindex,follow' })
</script>
<template><section class="page-heading search-heading"><p class="search-eyebrow">文字与风景之间</p><h1>站内搜索<span class="dot" aria-hidden="true" /></h1><p>把散落在日常里的片段，再找回来。</p></section><SearchPanel :release-id="site.releaseId" /></template>
<style scoped>.search-heading{max-width:850px;margin-left:auto;margin-right:auto}.search-eyebrow{font-size:12px!important;letter-spacing:.22em;margin-bottom:14px!important;color:var(--muted,#79756b)}</style>
