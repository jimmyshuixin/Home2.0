<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import MediaPreview from './MediaPreview.vue';
import MediaFilters from './MediaFilters.vue';
import MediaUpload from './MediaUpload.vue';
import { formatBytes, type MediaItem } from '../api';
import { useMediaCatalog } from '../useMediaCatalog';
const props = withDefaults(defineProps<{ kind?: string; title?: string; multiple?: boolean; maxSelected?: number; excludeIds?: string[] }>(), { maxSelected: 100 });
const emit = defineEmits<{ close: []; select: [item: MediaItem]; selectMany: [items: MediaItem[]] }>();
const dialog = ref<HTMLDialogElement>(), selected = ref<MediaItem[]>([]), notice = ref(''), page = ref(1);
const { filters, items, loading, error, indexing, indexed, nextCursor, load } = useMediaCatalog({ kind: props.kind, status: 'ready' });
const available = computed(() => items.value.filter(item => !props.excludeIds?.includes(item.id)));
const pageCount = computed(() => Math.max(1, Math.ceil(available.value.length / 24)));
const pageItems = computed(() => available.value.slice((Math.min(page.value, pageCount.value) - 1) * 24, Math.min(page.value, pageCount.value) * 24));
function choose(item: MediaItem, uploaded = false) {
  if (props.kind && item.kind !== props.kind || (item.processingStatus || item.status) !== 'ready' || props.excludeIds?.includes(item.id)) return;
  if (!props.multiple) { emit('select', item); dialog.value?.close(); return; }
  const index = selected.value.findIndex(row => row.id === item.id);
  if (index >= 0) { if (!uploaded) selected.value.splice(index, 1); return; }
  if (selected.value.length >= props.maxSelected) { notice.value = `本条内容还可以添加 ${props.maxSelected} 项，其他文件已保存在媒体库。`; return; }
  selected.value.push(item); notice.value = uploaded ? '上传已处理完成，并已自动选中。' : '';
}
function confirm() { emit('selectMany', selected.value); dialog.value?.close(); }
async function more() { await load(true); page.value = pageCount.value; }
onMounted(() => dialog.value?.showModal());
</script>
<template><dialog ref="dialog" class="modal wide" aria-labelledby="media-title" @close="emit('close')"><header class="modal-head"><div><p class="eyebrow">MEDIA LIBRARY</p><h2 id="media-title">{{ title || '上传或选择媒体' }}</h2></div><button type="button" aria-label="关闭媒体选择" @click="dialog?.close()">×</button></header><div class="modal-body"><MediaUpload embedded :kind="kind" :multiple="multiple" :max-files="maxSelected" @ready="item => choose(item, true)" @changed="load()"/><div class="mt24"><h3>从媒体库选择{{ multiple ? ' · 支持多选' : '' }}</h3><MediaFilters class="mt16" :filters="filters" picker :fixed-kind="!!kind"/></div><p class="hint mt16">只显示处理完成的文件；可以直接上传新文件，或复用已有素材。</p><p v-if="notice" class="notice mt16" role="status">{{ notice }}</p><p v-if="loading" role="status">{{ indexing ? '正在整理媒体目录，已核对 ' + indexed + ' 份文件…' : '正在读取媒体库…' }}</p><div v-if="error" class="notice error" role="alert">{{ error }} <button type="button" @click="load()">重试</button></div><div v-if="!loading && !error && !available.length" class="empty"><h3>{{ nextCursor ? '继续查找更多媒体' : '当前条件下暂无可选媒体' }}</h3><p>可以在上方上传，或调整筛选条件。</p></div><div class="media-grid mt16"><article v-for="item in pageItems" :key="item.id" class="media-choice" :class="{ selected: selected.some(row => row.id === item.id) }"><MediaPreview :item="item" compact/><strong>{{ item.originalName || item.id }}</strong><small>{{ formatBytes(item.originalBytes) }} · {{ item.category || '未分类' }}</small><button type="button" :aria-pressed="multiple ? selected.some(row => row.id === item.id) : undefined" :aria-label="'选用：' + (item.originalName || item.id)" @click="choose(item)">{{ multiple ? selected.some(row => row.id === item.id) ? '✓ 已选中，点击取消' : '选择这张照片' : '选用此媒体' }}</button></article></div><nav v-if="pageCount > 1" class="flex between mt24" aria-label="媒体选择分页"><button type="button" :disabled="page <= 1" @click="page--">上一页</button><span>{{ Math.min(page, pageCount) }} / {{ pageCount }}</span><button type="button" :disabled="page >= pageCount" @click="page++">下一页</button></nav><button v-if="nextCursor" class="mt24" :disabled="loading" @click="more">加载更多匹配媒体</button></div><footer v-if="multiple" class="picker-footer"><span>已选 {{ selected.length }} / {{ maxSelected }} 项</span><button type="button" class="primary" :disabled="!selected.length" @click="confirm">添加所选 {{ selected.length }} 项</button></footer></dialog></template>
<style scoped>.media-grid{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}.media-choice{border:1px solid var(--line);border-radius:7px;background:var(--white)}.media-choice.selected{border-color:var(--green);box-shadow:0 0 0 1px var(--green)}.media-choice>button{margin:0 12px 12px}.media-choice strong{padding-top:12px}.picker-footer{position:sticky;bottom:0;display:flex;align-items:center;justify-content:space-between;gap:16px;background:var(--white);padding:16px 24px;border-top:1px solid var(--line);z-index:3}@media(max-width:600px){.media-grid{grid-template-columns:1fr}.picker-footer{padding:12px 16px}}</style>
