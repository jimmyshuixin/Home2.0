import { computed, ref } from 'vue';
import { UploadMetadataSchema, type UploadMetadata } from '@xvyin/contracts';
import { api, ApiError, errorMessage, type MediaItem } from './api';
import { hashUpload, transferParts } from './upload-transfer';

interface UploadSession { uploadId: string; assetId: string; partSize: number; totalParts: number; state: string; parts: { partNumber: number; bytes: number }[] }
export interface UploadRow {
  key: string; name: string; size: number; mime: string; sha256?: string; uploadId?: string; assetId?: string;
  initializing?: boolean; file?: File; sent: number; hashing: number; state: string; error: string;
  result?: MediaItem; reused?: boolean; checks?: number; nextCheck?: number;
}
const rows = ref<UploadRow[]>([]), running = ref(false), paused = ref(false), issue = ref('');
const journalKey = 'xvyin-admin-upload-journal-v2', capacity = 100;
const terminal = (row: UploadRow) => ['ready', 'cancelled'].includes(row.state);
const activeCount = computed(() => rows.value.filter(row => !terminal(row)).length);
let initialized = false, activeController: AbortController | undefined, polling = false, authBlocked = false;
const verified = new WeakMap<File, string>();

export function uploadMime(file: Pick<File, 'name' | 'type'>) {
  return file.type || ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac', pdf: 'application/pdf', txt: 'text/plain', vtt: 'text/vtt' } as Record<string, string>)[file.name.split('.').pop()?.toLowerCase() ?? ''] || '';
}
function metadata(row: UploadRow): UploadMetadata {
  const kind = row.mime.startsWith('image/') ? 'image' : row.mime.startsWith('audio/') ? 'audio' : row.mime.startsWith('video/') ? 'video' : 'file';
  return UploadMetadataSchema.parse({ kind, originalName: row.name, expectedBytes: row.size, expectedMime: row.mime, ...(row.sha256 ? { expectedSha256: row.sha256 } : {}) });
}
function journal() {
  try { sessionStorage.setItem(journalKey, JSON.stringify(rows.value.filter(row => !terminal(row)).map(({ file, result, ...row }) => row))); }
  catch { issue.value = '浏览器无法保存续传记录，请在离开页面前完成上传。'; }
}
function initialize() {
  if (initialized) return; initialized = true;
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(journalKey) || sessionStorage.getItem('xvyin-admin-upload-journal-v1') || '[]');
    if (Array.isArray(saved)) rows.value = saved.filter(row => typeof row.key === 'string' && typeof row.name === 'string' && Number.isSafeInteger(row.size) && row.size > 0).map(row => ({
      ...row, file: undefined, result: undefined, state: row.assetId && row.state === 'processing' ? 'processing' : 'paused',
      error: row.assetId && row.state === 'processing' ? '' : '重新选择原文件后继续上传。', nextCheck: 0,
    }));
  } catch { issue.value = '旧续传记录无法读取，可以重新选择文件；服务器会核对重复内容。'; }
  scheduleProcessing();
}
async function transfer(row: UploadRow) {
  const file = row.file; if (!file) return;
  activeController = new AbortController(); const signal = activeController.signal; row.error = '';
  try {
    metadata(row); row.state = 'hashing'; row.hashing = 0;
    const digest = verified.get(file) || await hashUpload(file, signal, bytes => { row.hashing = bytes; });
    if (row.sha256 && digest !== row.sha256) throw new Error('文件内容与原上传不一致，请重新选择原文件。');
    verified.set(file, digest); row.sha256 = digest;
    if (!row.uploadId && !row.initializing) {
      const query = new URLSearchParams({ sha256: digest, bytes: String(row.size), kind: metadata(row).kind });
      const duplicate = (await api.request<MediaItem | null>(`/admin/media/duplicates?${query}`, { signal })).data;
      if (duplicate) { row.assetId = duplicate.id; row.result = duplicate; row.state = 'ready'; row.reused = true; row.sent = row.size; row.file = undefined; return; }
    }
    let session: UploadSession;
    if (row.uploadId) session = (await api.request<UploadSession>(`/admin/media/uploads/${encodeURIComponent(row.uploadId)}`, { signal })).data;
    else {
      row.initializing = true; journal();
      session = (await api.request<UploadSession>('/admin/media/uploads', { method: 'POST', body: metadata(row), signal, idempotencyKey: row.key })).data;
      row.uploadId = session.uploadId; row.initializing = false;
    }
    row.assetId = session.assetId; journal();
    if (['failed', 'expired', 'cancelled', 'aborted'].includes(session.state)) throw new Error('这次上传已结束或过期，请取消后重新上传。');
    if (!['processing', 'ready'].includes(session.state)) {
      const uploaded = new Set(session.parts.map(part => part.partNumber));
      row.sent = session.parts.reduce((sum, part) => sum + part.bytes, 0); row.state = 'uploading';
      const missing = Array.from({ length: session.totalParts }, (_, index) => index + 1).filter(number => !uploaded.has(number));
      await transferParts(missing, async number => {
        const body = file.slice((number - 1) * session.partSize, Math.min(number * session.partSize, row.size));
        const result = await api.request<{ bytes: number }>(`/admin/media/uploads/${encodeURIComponent(session.uploadId)}/parts/${number}`, { method: 'PUT', rawBody: body, signal });
        row.sent += result.data.bytes; journal();
      }, signal);
    }
    if (session.state !== 'ready') {
      row.state = 'completing';
      await api.request(`/admin/media/uploads/${encodeURIComponent(session.uploadId)}/complete`, { method: 'POST', body: {}, signal, idempotencyKey: `${row.key}:complete` });
    }
    row.state = 'processing'; row.sent = row.size; row.file = undefined; row.nextCheck = 0; scheduleProcessing();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) { paused.value = true; authBlocked = true; }
    row.state = 'paused'; row.error = signal.aborted ? '上传已暂停，已确认分片会保留。' : errorMessage(error);
  } finally { activeController = undefined; journal(); }
}
async function drain() {
  if (running.value || paused.value || authBlocked) return;
  running.value = true;
  try {
    for (;;) {
      const next = rows.value.find(row => row.state === 'queued' && row.file);
      // Bound expensive remote work too: each completed upload schedules media
      // processing. Wait for a slot before dispatching another GitHub job.
      if (!next || paused.value || rows.value.filter(row => row.state === 'processing').length >= 3) break;
      await transfer(next); // A failed file never prevents the next file from running.
    }
  } finally { running.value = false; }
}
async function check(row: UploadRow) {
  if (!row.assetId) return;
  try {
    const item = (await api.request<MediaItem>(`/admin/media/${encodeURIComponent(row.assetId)}`)).data;
    const state = item.processingStatus || item.status;
    if (state === 'ready') { row.result = item; row.state = 'ready'; row.error = ''; }
    else if (state === 'failed') { row.state = 'failed'; row.error = item.error?.message || '服务器处理失败，请在媒体库检查后重试。'; }
    else row.error = '';
  } catch (error) { row.error = errorMessage(error); if (error instanceof ApiError && error.status === 401) { paused.value = true; authBlocked = true; } }
  row.checks = (row.checks || 0) + 1;
  row.nextCheck = Date.now() + Math.min(60_000, 10_000 * 2 ** Math.min(row.checks, 3));
  journal(); void drain();
}
function scheduleProcessing() {
  if (polling || authBlocked || !rows.value.some(row => row.state === 'processing')) return;
  polling = true;
  setTimeout(async () => {
    // Only one metadata request at a time, with per-file backoff. Large batches
    // never trigger a request per row on every render or refresh the whole catalog.
    const row = rows.value.filter(row => row.state === 'processing' && (row.checks || 0) < 40).sort((a, b) => (a.nextCheck || 0) - (b.nextCheck || 0))[0];
    if (row && (row.nextCheck || 0) <= Date.now() && document.visibilityState !== 'hidden') await check(row);
    polling = false;
    if (rows.value.some(row => row.state === 'processing' && (row.checks || 0) < 40)) scheduleProcessing();
  }, 3500);
}
function add(files: readonly File[]) {
  initialize(); issue.value = ''; authBlocked = false; scheduleProcessing();
  const available = Math.max(0, capacity - activeCount.value), chosen = files.slice(0, available);
  if (chosen.length < files.length) issue.value = `本次加入 ${chosen.length} 个文件；队列最多保留 ${capacity} 个未完成文件，剩余 ${files.length - chosen.length} 个请稍后添加。`;
  const keys: string[] = [];
  for (const file of chosen) {
    const row: UploadRow = { key: crypto.randomUUID(), name: file.name, size: file.size, mime: uploadMime(file), file, sent: 0, hashing: 0, state: 'queued', error: '' };
    try { metadata(row); } catch { row.state = 'paused'; row.error = '文件格式或大小不符合上传要求；图片最多 100 MB。'; row.file = undefined; }
    rows.value.push(row); keys.push(row.key);
  }
  journal(); void drain(); return keys;
}
async function resume(row: UploadRow, file?: File) {
  if (file) {
    if (file.size !== row.size || file.name !== row.name) { row.error = '请选择同名、同大小的原文件；随后还会校验完整内容。'; return; }
    row.file = file;
  }
  if (!row.file) return;
  row.state = 'queued'; row.error = ''; paused.value = false; authBlocked = false; journal(); scheduleProcessing(); void drain();
}
async function cancel(row: UploadRow) {
  if (['uploading', 'hashing', 'completing', 'processing'].includes(row.state)) return;
  const previous = row.state; row.state = 'cancelling';
  try {
    if (!row.uploadId && row.initializing) { const session = await api.request<UploadSession>('/admin/media/uploads', { method: 'POST', body: metadata(row), idempotencyKey: row.key }); row.uploadId = session.data.uploadId; row.initializing = false; }
    if (row.uploadId && previous !== 'failed') await api.request(`/admin/media/uploads/${encodeURIComponent(row.uploadId)}/abort`, { method: 'POST', body: {} });
    row.state = 'cancelled'; row.file = undefined; journal();
  } catch (error) { row.state = previous; row.error = errorMessage(error); }
}
export function useUploadQueue() {
  initialize();
  return { rows, running, paused, issue, activeCount, capacity, add, resume, cancel,
    pause: () => { paused.value = true; activeController?.abort(); },
    continue: () => { paused.value = false; authBlocked = false; scheduleProcessing(); void drain(); },
    refresh: async (row: UploadRow) => { authBlocked = false; row.checks = 0; await check(row); scheduleProcessing(); },
    clear: () => { rows.value = rows.value.filter(row => !terminal(row)); journal(); },
  };
}
