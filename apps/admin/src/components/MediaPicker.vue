<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import MediaPreview from './MediaPreview.vue';
import { api, errorMessage, formatBytes, type MediaItem } from '../api';
const props = defineProps<{ kind?: string; title?: string }>();
const emit = defineEmits<{ close: []; select: [item: MediaItem] }>();
const dialog = ref<HTMLDialogElement>(); const items = ref<MediaItem[]>([]); const loading = ref(true); const error = ref(''); const query = ref('');
const nextCursor=ref<string>();
const ready = computed(() => items.value.filter(item => (item.processingStatus ?? item.status) === 'ready' && (!props.kind || item.kind === props.kind) && `${item.originalName ?? ''} ${item.id}`.toLowerCase().includes(query.value.toLowerCase())));
async function load(more=false) { loading.value = true; error.value = ''; try { const response=await api.request<MediaItem[]>('/admin/media'+(more&&nextCursor.value?'?cursor='+encodeURIComponent(nextCursor.value):''));items.value=more?[...items.value,...response.data]:response.data;nextCursor.value=response.meta.nextCursor; } catch (e) { error.value = errorMessage(e); } finally { loading.value = false; } }
onMounted(() => { dialog.value?.showModal(); void load(); });
</script>
<template><dialog ref="dialog" class="modal wide" aria-labelledby="media-title" @close="emit('close')"><header class="modal-head"><div><p class="eyebrow">MEDIA LIBRARY</p><h2 id="media-title">{{ title ?? '从媒体库选择' }}</h2></div><button type="button" aria-label="关闭媒体选择" @click="dialog?.close()">×</button></header><div class="modal-body"><input v-model="query" type="search" placeholder="搜索文件名" aria-label="搜索媒体"><p class="hint mt16">只显示校验完成、可用于草稿的媒体。</p><p v-if="loading" role="status">正在读取媒体库…</p><div v-else-if="error" class="notice error" role="alert">{{ error }} <button type="button" @click="load()">重试</button></div><div v-else-if="!ready.length" class="empty"><h3>暂无可选媒体</h3><p>先在媒体库上传文件，处理完成后再添加。</p></div><div v-else class="media-grid mt16"><article v-for="item in ready" :key="item.id" class="media-choice"><MediaPreview :item="item" compact/><strong>{{ item.originalName ?? item.id }}</strong><small>{{ formatBytes(item.originalBytes) }}</small><button type="button" :aria-label="`选用：${item.originalName ?? item.id}`" @click="emit('select', item); dialog?.close()">选用此媒体</button></article></div><button v-if="nextCursor" class="mt24" :disabled="loading" @click="load(true)">加载更多媒体</button></div></dialog></template>

<style scoped>.media-grid{grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}.media-choice{border:1px solid var(--line);border-radius:7px;background:var(--white)}.media-choice>button{margin:0 12px 12px}.media-choice strong{padding-top:12px}@media(max-width:600px){.media-grid{grid-template-columns:1fr}}</style>
