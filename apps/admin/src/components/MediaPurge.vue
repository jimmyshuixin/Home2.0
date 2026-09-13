<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api, errorMessage, formatBytes, type MediaItem } from '../api';
interface Job { id: string; assetId: string; status: string; processed: number; references: { kind: string; title: string }[]; totalKeys: number; completedKeys: number; bytes: number }
const props = defineProps<{ item?: MediaItem; resumeId?: string }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const dialog = ref<HTMLDialogElement>(), job = ref<Job>(), busy = ref(false), error = ref(''), agreed = ref(false);
const storageKey = 'xvyin-media-purge-job-v1'; let alive = true, checkKey = crypto.randomUUID(), fresh = false;
function remember(value: Job) { job.value = value; try { if (['checking','ready','deleting'].includes(value.status)) sessionStorage.setItem(storageKey, value.id); else sessionStorage.removeItem(storageKey); } catch { /* The open dialog still retains the job. */ } }
async function advance() {
  if (!job.value || busy.value) return; busy.value = true; error.value = '';
  try { for (let step = 0; alive && step < 15 && ['checking','deleting'].includes(job.value.status); step++) remember((await api.request<Job>('/admin/media/purge-jobs/' + job.value.id + '/advance', { method: 'POST', body: {} })).data); if (job.value.status === 'deleted') emit('changed'); }
  catch (e) { error.value = errorMessage(e); } finally { busy.value = false; }
}
async function start() {
  busy.value = true; error.value = '';
  try { remember(props.resumeId && !fresh ? (await api.request<Job>('/admin/media/purge-jobs/' + props.resumeId)).data : (await api.request<Job>('/admin/media/' + props.item!.id + '/purge-check', { method: 'POST', body: { expectedVersion: props.item!.version || 1 }, idempotencyKey: checkKey })).data); }
  catch (e) { error.value = errorMessage(e); } finally { busy.value = false; }
  await advance();
}
async function confirm() {
  if (!agreed.value || !job.value || busy.value) return; busy.value = true; error.value = '';
  try { remember((await api.request<Job>('/admin/media/purge-jobs/' + job.value.id + '/confirm', { method: 'POST', body: {} })).data); }
  catch (e) { error.value = errorMessage(e); } finally { busy.value = false; }
  await advance();
}
async function restart() { fresh = true; checkKey = crypto.randomUUID(); agreed.value = false; await start(); }
async function close() {
  if (busy.value) return;
  if (job.value && ['checking','ready'].includes(job.value.status)) {
    busy.value = true;
    try { remember((await api.request<Job>('/admin/media/purge-jobs/' + job.value.id + '/cancel', { method: 'POST', body: {} })).data); }
    catch (e) { error.value = errorMessage(e); return; } finally { busy.value = false; }
  }
  dialog.value?.close();
}
onMounted(() => { dialog.value?.showModal(); void start(); });
onBeforeUnmount(() => { alive = false; });
</script>
<template><dialog ref="dialog" class="modal" aria-labelledby="purge-title" @cancel.prevent="close" @close="emit('close')"><header class="modal-head"><div><p class="eyebrow">MEDIA LIBRARY</p><h2 id="purge-title">永久删除媒体</h2></div><button type="button" :disabled="busy" aria-label="关闭删除检查" @click="close">×</button></header><div class="modal-body">
  <p class="break"><strong>{{ item?.originalName || '继续媒体清理任务' }}</strong></p>
  <p v-if="!job" class="hint mt16">先检查引用，再由你确认删除。</p>
  <template v-else-if="job.status === 'checking'"><p class="mt16" role="status">正在检查草稿、公开内容和历史版本，已核对 {{ job.processed }} 条记录。</p><p class="hint mt8">检查期间暂缓内容保存与发布。关闭本窗口可取消检查。</p></template>
  <template v-else-if="job.status === 'blocked'"><p class="notice mt16">这份媒体仍被使用，已阻止永久删除。</p><ul class="references"><li v-for="(reference,index) in job.references" :key="index">{{ reference.title }}</li></ul><p class="hint">移入回收站不会破坏这些引用；可以恢复媒体。历史版本的引用也会保留。</p></template>
  <template v-else-if="job.status === 'ready'"><p class="notice mt16">引用检查通过，可释放 {{ formatBytes(job.bytes) }}，包含原件和处理后的版本。</p><label class="confirm-check mt16"><input v-model="agreed" type="checkbox">我确认永久删除这些文件，删除后无法恢复。</label><button type="button" class="danger mt24" :disabled="busy || !agreed" @click="confirm">确认永久删除</button></template>
  <template v-else-if="job.status === 'deleting'"><p class="mt16" role="status">正在删除文件：{{ job.completedKeys }} / {{ job.totalKeys }}</p><progress :max="job.totalKeys" :value="job.completedKeys" aria-label="永久删除进度"></progress><p class="hint">中断后可继续；全部对象删除成功后才会扣减已用容量。</p></template>
  <p v-else-if="job.status === 'deleted'" class="notice mt16" role="status">已永久删除，释放 {{ formatBytes(job.bytes) }}。</p>
  <p v-else class="notice mt16">检查已取消或过期，请关闭后重新检查。</p>
  <p v-if="error" class="notice error mt16" role="alert">{{ error }}</p>
  <button v-if="job && ['checking','deleting'].includes(job.status)" type="button" class="mt24" :disabled="busy" @click="advance">{{ busy ? '正在处理…' : '继续处理' }}</button>
  <button v-if="!job && error" type="button" class="mt24" :disabled="busy" @click="start">重新检查</button>
  <button v-if="item && job && ['blocked','expired','cancelled'].includes(job.status)" type="button" class="mt24" :disabled="busy" @click="restart">重新检查引用</button>
  <button type="button" class="mt24" :disabled="busy" @click="close">{{ job && ['checking','ready'].includes(job.status) ? '取消检查并关闭' : job?.status === 'deleting' ? '稍后继续' : '关闭' }}</button>
</div></dialog></template>
<style scoped>.references{padding-left:20px;margin:18px 0;overflow-wrap:anywhere}.references li+li{margin-top:10px}.confirm-check{display:flex;gap:10px;align-items:flex-start}.confirm-check input{width:auto;flex:none;margin-top:5px}</style>
