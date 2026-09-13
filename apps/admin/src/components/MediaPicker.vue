<script setup lang="ts">
import { onMounted, ref } from 'vue';
import MediaPreview from './MediaPreview.vue';
import MediaFilters from './MediaFilters.vue';
import { formatBytes, type MediaItem } from '../api';
import { useMediaCatalog } from '../useMediaCatalog';
const props = defineProps<{ kind?: string; title?: string }>();
const emit = defineEmits<{ close: []; select: [item: MediaItem] }>();
const dialog = ref<HTMLDialogElement>();
const { filters, items, loading, error, indexing, indexed, nextCursor, load } = useMediaCatalog({ kind: props.kind, status: 'ready' });
onMounted(() => dialog.value?.showModal());
</script>
<template><dialog ref="dialog" class="modal wide" aria-labelledby="media-title" @close="emit('close')"><header class="modal-head"><div><p class="eyebrow">MEDIA LIBRARY</p><h2 id="media-title">{{ title || '从媒体库选择' }}</h2></div><button type="button" aria-label="关闭媒体选择" @click="dialog?.close()">×</button></header><div class="modal-body"><MediaFilters :filters="filters" picker :fixed-kind="!!kind"/><p class="hint mt16">搜索和筛选覆盖整个媒体库，只显示处理完成、未移入回收站的文件。</p><p v-if="loading" role="status">{{ indexing ? '正在整理媒体目录，已核对 ' + indexed + ' 份文件…' : '正在读取媒体库…' }}</p><div v-if="error" class="notice error" role="alert">{{ error }} <button type="button" @click="load()">重试</button></div><div v-if="!loading && !error && !items.length" class="empty"><h3>{{ nextCursor ? '继续查找更多媒体' : '当前条件下暂无可选媒体' }}</h3><p>可以调整筛选，或先在媒体库上传并处理文件。</p></div><div class="media-grid mt16"><article v-for="item in items" :key="item.id" class="media-choice"><MediaPreview :item="item" compact/><strong>{{ item.originalName || item.id }}</strong><small>{{ formatBytes(item.originalBytes) }} · {{ item.category || '未分类' }}</small><button type="button" :aria-label="'选用：' + (item.originalName || item.id)" @click="emit('select', item); dialog?.close()">选用此媒体</button></article></div><button v-if="nextCursor" class="mt24" :disabled="loading" @click="load(true)">{{ items.length ? '加载更多匹配媒体' : '继续查找' }}</button></div></dialog></template>
<style scoped>.media-grid{grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}.media-choice{border:1px solid var(--line);border-radius:7px;background:var(--white)}.media-choice>button{margin:0 12px 12px}.media-choice strong{padding-top:12px}@media(max-width:600px){.media-grid{grid-template-columns:1fr}}</style>
