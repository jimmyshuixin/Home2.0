<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { api, dateTime, errorMessage, formatBytes, type MediaItem } from '../api';
import { useMediaCatalog } from '../useMediaCatalog';
import MediaUpload from './MediaUpload.vue';
import MediaPreview from './MediaPreview.vue';
import MediaFilters from './MediaFilters.vue';
import MediaPurge from './MediaPurge.vue';
const { filters, items, quota, loading, error, indexing, indexed, nextCursor, load } = useMediaCatalog();
const page = ref(1), pageCount = computed(() => Math.max(1, Math.ceil(items.value.length / 24)));
const pageItems = computed(() => items.value.slice((Math.min(page.value, pageCount.value) - 1) * 24, Math.min(page.value, pageCount.value) * 24));
async function more() { await load(true); page.value = pageCount.value; }
const editDialog = ref<HTMLDialogElement>(), selected = ref<MediaItem>(), action = ref<'category'|'trash'>('category'), category = ref(''), saving = ref(false), actionError = ref('');
const purgeItem = ref<MediaItem>(), purgeId = ref(''), showPurge = ref(false);
const backfillBusy = ref(false), backfillNotice = ref(''), backfillError = ref('');
async function identifyOldPhotos() {
  if (backfillBusy.value) return;
  backfillBusy.value = true; backfillNotice.value = ''; backfillError.value = '';
  try {
    await api.request('/admin/media/photography-backfill', { method: 'POST', body: {} });
    backfillNotice.value = '后台已开始识别旧照片参数。完成后，可在发布中心重建公开页面，让网站显示识别到的摄影信息。';
  } catch (error) { backfillError.value = errorMessage(error); }
  finally { backfillBusy.value = false; }
}
const stateText: Record<string,string> = {ready:'可用',processing:'处理中',failed:'处理失败'};
async function edit(item: MediaItem, mode: 'category'|'trash') { selected.value = item; action.value = mode; category.value = item.category || ''; actionError.value = ''; await nextTick(); editDialog.value?.showModal(); }
async function save() {
  if (!selected.value || saving.value) return; saving.value = true; actionError.value = '';
  try { await api.request('/admin/media/' + selected.value.id + (action.value === 'trash' ? '/trash' : ''), { method: action.value === 'trash' ? 'POST' : 'PATCH', body: { expectedVersion: selected.value.version || 1, ...(action.value === 'category' ? { category: category.value.trim() } : {}) } }); editDialog.value?.close(); await load(); }
  catch (e) { actionError.value = errorMessage(e); } finally { saving.value = false; }
}
async function restore(item: MediaItem) { if (saving.value) return; saving.value = true; error.value = ''; try { await api.request('/admin/media/' + item.id + '/restore', { method: 'POST', body: { expectedVersion: item.version || 1 } }); await load(); } catch(e) { error.value = errorMessage(e); } finally { saving.value = false; } }
function purge(item?: MediaItem) { purgeItem.value = item; if (item) purgeId.value = item.purgeJobId || ''; showPurge.value = true; }
function closedPurge() { showPurge.value = false; try { purgeId.value = sessionStorage.getItem('xvyin-media-purge-job-v1') || ''; } catch { purgeId.value = ''; } void load(); }
onMounted(() => { try { const saved = sessionStorage.getItem('xvyin-media-purge-job-v1'); if (saved && /^[\da-f-]{36}$/i.test(saved)) purgeId.value = saved; } catch { /* Resume is optional. */ } });
</script>
<template><section>
  <MediaUpload @changed="load()"/>
  <div v-if="quota" class="quota panel mt24"><div class="flex between"><span>媒体已用 {{ formatBytes(quota.usedBytes) }} · 上传预留 {{ formatBytes(quota.reservedBytes) }}</span><strong>媒体上限 {{ formatBytes(quota.limitBytes) }}</strong></div><progress :max="quota.limitBytes" :value="quota.usedBytes + quota.reservedBytes" aria-label="媒体容量使用"></progress><p class="hint">包含媒体原件和已处理版本；历史网站构建还会占用额外存储。回收站文件在永久删除前仍计入容量。</p></div>
  <div class="library-heading mt32"><div class="tabs" aria-label="媒体范围"><button :class="{active:filters.lifecycle === 'active'}" :aria-pressed="filters.lifecycle === 'active'" @click="filters.lifecycle = 'active'">媒体库</button><button :class="{active:filters.lifecycle === 'trash'}" :aria-pressed="filters.lifecycle === 'trash'" @click="filters.lifecycle = 'trash'">回收站</button></div><div class="library-actions"><button type="button" :disabled="backfillBusy" :aria-busy="backfillBusy" @click="identifyOldPhotos">{{backfillBusy?'正在提交…':'识别旧照片参数'}}</button><button type="button" :disabled="loading" @click="load()">刷新</button></div></div><p v-if="backfillNotice" class="notice success mt16" role="status">{{backfillNotice}}</p><p v-if="backfillError" class="notice error mt16" role="alert">{{backfillError}}</p>
  <p v-if="filters.lifecycle === 'trash'" class="hint mt16">可以恢复文件。永久删除前会检查所有引用；仍被内容或历史版本使用的文件会保留。</p>
  <p v-if="purgeId" class="notice mt16">有一个媒体清理任务尚未结束。<button type="button" @click="purge()">继续查看</button></p>
  <div class="panel mt24"><MediaFilters :filters="filters"/></div>
  <p v-if="indexing" class="loading" role="status">正在整理媒体目录，已核对 {{ indexed }} 份文件…</p>
  <p v-else-if="loading" class="loading" role="status">正在查询媒体…</p>
  <p v-if="error" class="notice error mt16" role="alert">{{ error }} <button type="button" @click="load()">重试</button></p>
  <div v-if="!loading && !error && !items.length" class="empty mt24"><h3>{{ nextCursor ? '继续查找更多文件' : '当前条件下没有文件' }}</h3><p>{{ nextCursor ? '已检查的一批文件没有匹配项，可以继续查询。' : '调整搜索、类型或分类，或上传新的媒体。' }}</p></div>
  <div class="media-grid mt24"><article v-for="item in pageItems" :key="item.id" class="media-card"><MediaPreview v-if="item.lifecycle !== 'purging'" :item="item" compact/><p v-else class="notice">清理尚未完成，可以继续删除。</p><div class="media-caption"><strong class="break">{{ item.originalName || item.id }}</strong><p class="hint mt8">原件 {{ formatBytes(item.originalBytes) }} · 共占用 {{ formatBytes(item.totalBytes || item.originalBytes) }}</p><p class="hint">{{ dateTime(item.createdAt) }}</p><div class="flex mt8"><span class="badge" :class="{green:item.status === 'ready'}">{{ stateText[item.status || ''] || '等待校验' }}</span><span class="category">{{ item.category || '未分类' }}</span></div><p v-if="item.error" class="error-text mt8">{{ item.error.message }}</p><div class="card-actions mt16"><button v-if="item.lifecycle !== 'purging'" type="button" @click="edit(item,'category')">编辑分类</button><button v-if="filters.lifecycle === 'active'" type="button" :disabled="item.status === 'processing' || saving" @click="edit(item,'trash')">移入回收站</button><template v-else><button v-if="item.lifecycle !== 'purging'" type="button" :disabled="saving" @click="restore(item)">恢复</button><button type="button" class="danger" :disabled="saving" @click="purge(item)">{{ item.lifecycle === 'purging' ? '继续删除' : '永久删除…' }}</button></template></div></div></article></div>
  <nav v-if="pageCount>1" class="flex between mt24" aria-label="媒体库分页"><button type="button" :disabled="page<=1" @click="page--">上一页</button><span>{{Math.min(page,pageCount)}} / {{pageCount}}</span><button type="button" :disabled="page>=pageCount" @click="page++">下一页</button></nav><button v-if="nextCursor" type="button" class="mt24" :disabled="loading" @click="more">{{ items.length ? '加载更多匹配媒体' : '继续查找' }}</button>
  <dialog ref="editDialog" class="modal" aria-labelledby="media-edit-title" @cancel="event => { if (saving) event.preventDefault(); }"><header class="modal-head"><h2 id="media-edit-title">{{ action === 'category' ? '编辑媒体分类' : '移入回收站' }}</h2><button type="button" aria-label="关闭" :disabled="saving" @click="editDialog?.close()">×</button></header><form class="modal-body" @submit.prevent="save"><p class="break">{{ selected?.originalName }}</p><label v-if="action === 'category'" class="category-label mt24">分类名称<input v-model="category" maxlength="40" placeholder="例如：日常、健身、旅行"><small class="hint">留空即为未分类；同名分类可以一起筛选。</small></label><p v-else class="mt24">文件将从媒体选择器移除，已有页面的引用继续有效。之后可以在回收站恢复。</p><p v-if="actionError" class="notice error mt16" role="alert">{{ actionError }}</p><div class="flex mt24"><button type="submit" class="primary" :disabled="saving">{{ saving ? '正在保存…' : action === 'category' ? '保存分类' : '确认移入回收站' }}</button><button type="button" :disabled="saving" @click="editDialog?.close()">取消</button></div></form></dialog>
  <MediaPurge v-if="showPurge" :item="purgeItem" :resume-id="purgeId || undefined" @close="closedPurge" @changed="load()"/>
</section></template>
<style scoped>.media-grid{grid-template-columns:repeat(auto-fill,minmax(245px,1fr))}.library-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.library-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.tabs{display:flex;gap:8px}.tabs .active{background:var(--green);color:white}.category{font-size:12px;overflow-wrap:anywhere;color:var(--green)}.card-actions{display:flex;flex-wrap:wrap;gap:8px}.card-actions button{font-size:12px;padding:7px 10px}.category-label{display:grid;gap:10px}@media(max-width:600px){.media-grid{grid-template-columns:1fr}.library-heading{gap:8px}.library-actions{width:100%;justify-content:flex-end}}</style>
