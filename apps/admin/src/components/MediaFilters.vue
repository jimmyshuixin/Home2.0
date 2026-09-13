<script setup lang="ts">
defineProps<{ filters: { q: string; kind: string; status: string; category: string; uncategorized: boolean; order: string }; picker?: boolean; fixedKind?: boolean }>();
</script>
<template><div class="media-filters">
  <label class="search">搜索<input v-model="filters.q" type="search" maxlength="100" placeholder="搜索整个媒体库的文件名"></label>
  <label v-if="!fixedKind">类型<select v-model="filters.kind" aria-label="类型"><option value="">全部类型</option><option value="image">图片</option><option value="audio">音频</option><option value="video">视频</option><option value="file">附件</option></select></label>
  <label v-if="!picker">状态<select v-model="filters.status" aria-label="状态"><option value="">全部状态</option><option value="ready">可用</option><option value="processing">处理中</option><option value="failed">处理失败</option></select></label>
  <label>分类<input v-model="filters.category" type="text" maxlength="40" :disabled="filters.uncategorized" placeholder="输入分类名称"></label>
  <label>排序<select v-model="filters.order" aria-label="排序"><option value="created:desc">最新上传</option><option value="created:asc">最早上传</option><option value="name:asc">文件名 A → Z</option><option value="name:desc">文件名 Z → A</option><option value="size:desc">占用空间从大到小</option><option value="size:asc">占用空间从小到大</option></select></label>
  <label class="check"><input v-model="filters.uncategorized" type="checkbox">仅未分类</label>
</div></template>
<style scoped>.media-filters{display:grid;grid-template-columns:minmax(180px,1.6fr) repeat(4,minmax(110px,1fr));gap:14px;align-items:end}.media-filters label{display:grid;gap:7px;font-size:12px;color:var(--muted);min-width:0}.media-filters input,.media-filters select{width:100%;min-width:0}.media-filters .check{display:flex;align-items:center;gap:8px}.check input{width:auto}@media(max-width:1050px){.media-filters{grid-template-columns:repeat(3,minmax(0,1fr))}.search{grid-column:span 2}}@media(max-width:600px){.media-filters{grid-template-columns:repeat(2,minmax(0,1fr))}.search{grid-column:1/-1}}</style>
