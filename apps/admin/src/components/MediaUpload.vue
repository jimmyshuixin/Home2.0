<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { UploadMetadataSchema, type UploadMetadata } from '@xvyin/contracts';
import { api, errorMessage, formatBytes, type MediaItem } from '../api';
import { hashUpload, transferParts } from '../upload-transfer';
const emit = defineEmits<{ changed: [] }>();
interface UploadSession { uploadId: string; assetId: string; partSize: number; totalParts: number; expiresAt: string; state: string; parts: { partNumber: number; etag: string; bytes: number }[] }
interface QueueItem { key: string; name: string; size: number; mime: string; sha256?: string; uploadId?: string; initializing?: boolean; file?: File; sent: number; hashing: number; state: string; error: string }
const queue = ref<QueueItem[]>([]), running = ref(false);
let controller = new AbortController();
const verifiedFiles = new WeakMap<File, string>();
const journalKey = 'xvyin-admin-upload-journal-v1';
function journal() {
  try { sessionStorage.setItem(journalKey, JSON.stringify(queue.value.filter(item => item.sha256 && !['processing', 'ready', 'reused', 'cancelled'].includes(item.state)).map(({ file, ...metadata }) => metadata))); }
  catch { /* Upload can still resume while the selected File remains available. */ }
}
function mime(file: File) { return file.type || ({ mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', vtt: 'text/vtt' } as Record<string, string>)[file.name.split('.').pop()?.toLowerCase() ?? ''] || ''; }
function metadata(item: QueueItem): UploadMetadata {
  const kind = item.mime.startsWith('image/') ? 'image' : item.mime.startsWith('audio/') ? 'audio' : item.mime.startsWith('video/') ? 'video' : 'file';
  return UploadMetadataSchema.parse({ kind, originalName: item.name, expectedBytes: item.size, expectedMime: item.mime, ...(item.sha256 ? { expectedSha256: item.sha256 } : {}) });
}
async function transfer(item: QueueItem) {
  if (!item.file || running.value) return;
  running.value = true; item.error = ''; controller = new AbortController();
  try {
    metadata(item); item.state = 'hashing'; item.hashing = 0;
    const digest = verifiedFiles.get(item.file) || await hashUpload(item.file, controller.signal, bytes => { item.hashing = bytes; });
    if (item.sha256 && digest !== item.sha256) throw new Error('文件内容与原上传不一致，请重新选择原文件。');
    verifiedFiles.set(item.file, digest); item.sha256 = digest;
    if (!item.uploadId && !item.initializing) {
      const query = new URLSearchParams({ sha256: digest, bytes: String(item.size), kind: metadata(item).kind });
      const duplicate = (await api.request<MediaItem | null>(`/admin/media/duplicates?${query}`, { signal: controller.signal })).data;
      if (duplicate) { item.state = 'reused'; item.sent = item.size; item.file = undefined; journal(); emit('changed'); return; }
    }
    let session: UploadSession;
    if (item.uploadId) session = (await api.request<UploadSession>(`/admin/media/uploads/${encodeURIComponent(item.uploadId)}`, { signal: controller.signal })).data;
    else { item.initializing = true; journal(); session = (await api.request<UploadSession>('/admin/media/uploads', { method: 'POST', body: metadata(item), signal: controller.signal, idempotencyKey: item.key })).data; item.uploadId = session.uploadId; item.initializing = false; journal(); }
    if (session.state === 'processing' || session.state === 'ready') {
      // A prior complete may have committed while GitHub dispatch failed. Retry
      // the idempotent completion endpoint before dropping the local journal.
      if (session.state === 'processing') await api.request(`/admin/media/uploads/${encodeURIComponent(session.uploadId)}/complete`, { method: 'POST', body: {}, signal: controller.signal });
      item.state = session.state; item.sent = item.size; item.file = undefined; journal(); emit('changed'); return;
    }
    if (['failed', 'expired', 'cancelled', 'aborted'].includes(session.state)) throw new Error('这次上传已结束或过期，请取消后重新上传。');
    const uploaded = new Set(session.parts.map(part => part.partNumber));
    item.sent = session.parts.reduce((sum, part) => sum + part.bytes, 0); item.state = 'uploading'; journal();
    const missing = Array.from({ length: session.totalParts }, (_, index) => index + 1).filter(number => !uploaded.has(number));
    await transferParts(missing, async number => {
      const body = item.file!.slice((number - 1) * session.partSize, Math.min(number * session.partSize, item.size));
      const result = await api.request<{ bytes: number }>(`/admin/media/uploads/${encodeURIComponent(session.uploadId)}/parts/${number}`, { method: 'PUT', rawBody: body, signal: controller.signal });
      item.sent += result.data.bytes; journal();
    }, controller.signal);
    item.state = 'completing';
    await api.request(`/admin/media/uploads/${encodeURIComponent(session.uploadId)}/complete`, { method: 'POST', body: {}, signal: controller.signal, idempotencyKey: `${item.key}:complete` });
    item.state = 'processing'; item.file = undefined; journal(); emit('changed');
  } catch (error) { item.state = 'paused'; item.error = controller.signal.aborted ? '上传已暂停，已确认的分片会保留。' : errorMessage(error); journal(); }
  finally { running.value = false; }
}
async function choose(event: Event, resume?: QueueItem) {
  const input = event.target as HTMLInputElement, files = Array.from(input.files ?? []); input.value = '';
  if (resume) {
    const file = files[0]; if (!file) return;
    if (file.size !== resume.size || file.name !== resume.name) { resume.error = '请选择同名、同大小的原文件；随后还会校验完整内容。'; return; }
    resume.file = file; await transfer(resume); return;
  }
  for (const file of files) {
    queue.value.push({ key: crypto.randomUUID(), name: file.name, size: file.size, mime: mime(file), file, sent: 0, hashing: 0, state: 'queued', error: '' });
    await transfer(queue.value[queue.value.length - 1]!);
  }
}
async function cancel(item: QueueItem) {
  if (running.value) return;
  try {
    if (!item.uploadId && item.initializing) { const session = await api.request<UploadSession>('/admin/media/uploads', { method: 'POST', body: metadata(item), idempotencyKey: item.key }); item.uploadId = session.data.uploadId; item.initializing = false; journal(); }
    if (item.uploadId) await api.request(`/admin/media/uploads/${encodeURIComponent(item.uploadId)}/abort`, { method: 'POST', body: {} }); item.state = 'cancelled'; item.file = undefined; journal(); emit('changed');
  }
  catch (error) { item.error = errorMessage(error); }
}
const labels: Record<string, string> = { queued: '等待上传', hashing: '正在校验文件', uploading: '上传中', completing: '正在提交校验', processing: '等待服务端处理', ready: '可用于内容', reused: '已存在，直接复用', paused: '已暂停', cancelled: '已取消' };
onMounted(() => {
  try { const saved: unknown = JSON.parse(sessionStorage.getItem(journalKey) ?? '[]'); if (Array.isArray(saved)) queue.value = saved.filter(item => typeof item.key === 'string' && typeof item.sha256 === 'string' && typeof item.name === 'string' && Number.isSafeInteger(item.size)).slice(0, 20).map(item => ({ ...item, state: 'paused', error: '重新选择原文件后继续上传。' })); }
  catch { /* Ignore malformed resume metadata. */ }
});
onBeforeUnmount(() => { controller.abort(); journal(); });
</script>

<template>
  <section aria-label="上传媒体">
    <div class="panel media-upload"><div><h2>上传到媒体库</h2><p class="muted">图片、音频、视频和附件，统一保存与复用。</p><p class="hint mt16">单个视频最多 512 MB。支持暂停续传；相同文件直接复用。</p></div><label class="button primary" :class="{ disabled: running }"><input class="sr-only" type="file" multiple :disabled="running" accept="image/jpeg,image/png,image/webp,audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,video/mp4,video/webm,application/pdf,text/plain,text/vtt" @change="choose($event)">＋ 选择文件</label></div>
    <div v-if="queue.length" class="panel mt24"><h2>上传队列</h2><article v-for="item in queue" :key="item.key" class="upload-row">
      <div class="flex between"><strong class="break">{{ item.name }}</strong><span class="badge">{{ labels[item.state] || item.state }}</span></div>
      <progress :max="item.size" :value="item.state === 'hashing' ? item.hashing : item.sent" :aria-label="`${item.name} 进度`" />
      <small>{{ formatBytes(item.sent) }} / {{ formatBytes(item.size) }}{{ item.state === 'reused' ? ' · 已复用媒体库原有文件' : ' 已由服务器确认' }}</small>
      <p v-if="item.error" class="error-text mt8" role="alert">{{ item.error }}</p>
      <div class="flex mt8"><button v-if="running && ['uploading', 'hashing'].includes(item.state)" type="button" @click="controller.abort()">暂停</button><template v-if="item.state === 'paused'"><button v-if="item.file" type="button" :disabled="running" @click="transfer(item)">重试未完成分片</button><label v-else class="button"><input class="sr-only" type="file" :disabled="running" @change="choose($event, item)">重新选择原文件</label><button type="button" :disabled="running" @click="cancel(item)">取消上传</button></template></div>
    </article></div>
  </section>
</template>
