<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api, ApiError, dateTime, errorMessage, type ReleaseJob } from '../api';
import { changeKey, changeLabels, collectionLabels, isPending, MAX_RELEASE_CHANGES, releaseCollections, releaseNeedsPolling, releaseSignature, selectionChanges, type ReleaseCandidate, type ReleaseChange } from '../releases';
export type { ReleaseChange } from '../releases';
const props = defineProps<{ changes?: ReleaseChange[] }>();
const emit = defineEmits<{ close: []; activated: []; preview: [releaseId: string] }>();
const dialog = ref<HTMLDialogElement>();
const jobs = ref<ReleaseJob[]>([]), candidates = ref<ReleaseCandidate[]>([]);
const selected = ref<ReleaseJob | null>(null), activeId = ref<string | null>(null);
const choices = ref<Record<string, 'publish' | 'hide'>>({});
const busy = ref(false), loading = ref(true), complete = ref(false), issue = ref('');
const section = ref<'changes' | 'history'>('changes'), filter = ref('pending'), search = ref('');
const nextJobCursor = ref<string>(), loadingMore = ref(false), pollFailed = ref(false);
const sendingKey = ref(crypto.randomUUID());
let timer: ReturnType<typeof setTimeout> | undefined;
let alive = true, loadSequence = 0;
const controller = new AbortController();
const selectedChanges = computed(() => selectionChanges(candidates.value, choices.value));
const selectedItems = computed(() => candidates.value.filter(item => choices.value[changeKey(item)]));
const pending = computed(() => candidates.value.filter(isPending));
const selectedHidden = computed(() => candidates.value.filter(item => item.changeKind === 'hidden' && choices.value[changeKey(item)] === 'publish').length);
const filtered = computed(() => candidates.value.filter(item => (choices.value[changeKey(item)] || filter.value === 'all' || filter.value === 'pending' && isPending(item) || filter.value === item.collection || filter.value === 'hidden' && item.changeKind === 'hidden') && `${item.title} ${collectionLabels[item.collection]}`.toLowerCase().includes(search.value.toLowerCase())));
const sortedJobs = computed(() => [...jobs.value].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')));
const signature = computed(() => releaseSignature(selectedChanges.value, activeId.value));
watch(signature, () => { sendingKey.value = crypto.randomUUID(); });
const labels: Record<string, string> = { live: '正在使用', activating: '正在切换', reconciling: '正在确认切换结果', queued: '等待生成', building: '正在生成页面', rendering: '正在生成页面', validating: '正在校验', uploading: '正在保存页面', ready: '待预览与确认', active: '正在使用', published: '已发布', failed: '发布失败', cancelled: '已取消', superseded: '已有更新版本' };
function statusLabel(job: ReleaseJob) { if (job.status === 'live' && job.id !== activeId.value) return '历史版本'; return job.status === 'live' && releaseNeedsPolling(job) ? '已上线，正在同步记录' : labels[job.status] ?? job.status; }
function updateJob(job: ReleaseJob) { const index = jobs.value.findIndex(value => value.id === job.id); if (index >= 0) jobs.value[index] = job; else jobs.value.unshift(job); }
function toggle(item: ReleaseCandidate, checked: boolean) { const next = { ...choices.value }; if (checked) next[changeKey(item)] = 'publish'; else delete next[changeKey(item)]; choices.value = next; }
function selectPending() { choices.value = Object.fromEntries(pending.value.map(item => [changeKey(item), 'publish'])); }
async function loadJobs(more = false) {
  const result = await api.request<ReleaseJob[]>(`/admin/releases${more && nextJobCursor.value ? `?cursor=${encodeURIComponent(nextJobCursor.value)}` : ''}`, { signal: controller.signal });
  const keep = selected.value;
  jobs.value = more ? [...new Map([...jobs.value, ...result.data].map(job => [job.id, job])).values()] : result.data;
  if (keep && !jobs.value.some(job => job.id === keep.id)) jobs.value.unshift(keep);
  const nextActive = result.meta.activeReleaseId ?? null;
  if (complete.value && activeId.value !== nextActive) { complete.value = false; issue.value = '公开版本已更新，请重新读取改动清单后再生成预览。'; }
  nextJobCursor.value = result.meta.nextCursor; activeId.value = nextActive;
}
async function loadMoreJobs() { loadingMore.value = true; try { await loadJobs(!!nextJobCursor.value); } catch (error) { issue.value = errorMessage(error); } finally { loadingMore.value = false; } }
async function loadWorkspace() {
  const sequence = ++loadSequence;
  loading.value = true; complete.value = false; issue.value = ''; candidates.value = []; choices.value = {};
  try {
    await loadJobs();
    const baseline = activeId.value;
    for (const collection of releaseCollections) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const params = new URLSearchParams({ collection, expectedReleaseId: baseline ?? 'unpublished' });
        if (cursor) params.set('cursor', cursor);
        const response = await api.request<ReleaseCandidate[]>(`/admin/release-changes?${params}`, { signal: controller.signal });
        if (!alive || sequence !== loadSequence) return;
        if ((response.meta.activeReleaseId ?? null) !== baseline) throw new Error('公开版本已发生变化，请重新读取发布清单。');
        candidates.value.push(...response.data);
        cursor = response.meta.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('发布清单分页异常，请重新读取。');
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
    if (props.changes?.length) {
      const matching = props.changes.filter(change => candidates.value.some(item => changeKey(item) === changeKey(change) && item.version === change.version && item.actions.includes(change.action)));
      choices.value = Object.fromEntries(matching.map(change => [changeKey(change), change.action]));
      if (matching.length !== props.changes.length) issue.value = '部分内容已在其他窗口更新，已取消预选。请核对当前版本后重新选择。';
    }
    else selectPending();
    complete.value = true;
  } catch (error) { if (alive) issue.value = errorMessage(error); }
  finally { if (alive && sequence === loadSequence) loading.value = false; }
}
function poll() {
  if (timer) clearTimeout(timer);
  if (!alive || !releaseNeedsPolling(selected.value) || pollFailed.value) return;
  const id = selected.value!.id;
  timer = setTimeout(async () => {
    try {
      const result = await api.request<ReleaseJob>(`/admin/releases/${id}`, { signal: controller.signal });
      if (alive && selected.value?.id === id) {
        const wasPending = releaseNeedsPolling(selected.value);
        selected.value = result.data; updateJob(result.data);
        if (result.data.status === 'live' && wasPending && !releaseNeedsPolling(result.data)) { await loadJobs(); emit('activated'); }
      }
    } catch (error) { if (alive) { issue.value = errorMessage(error); pollFailed.value = true; } }
    finally { poll(); }
  }, 2500);
}
function selectJob(job: ReleaseJob) { selected.value = job; section.value = 'history'; issue.value = ''; pollFailed.value = false; poll(); }
async function refreshSelected() {
  if (!selected.value) return;
  busy.value = true; issue.value = '';
  try { const result = await api.request<ReleaseJob>(`/admin/releases/${selected.value.id}`); selected.value = result.data; updateJob(result.data); pollFailed.value = false; poll(); }
  catch (error) { issue.value = errorMessage(error); }
  finally { busy.value = false; }
}
async function create() {
  if (!complete.value || !selectedChanges.value.length || selectedChanges.value.length > MAX_RELEASE_CHANGES) return;
  busy.value = true; issue.value = '';
  try {
    const result = await api.request<ReleaseJob>('/admin/releases', { method: 'POST', body: { changes: selectedChanges.value, expectedReleaseId: activeId.value }, idempotencyKey: sendingKey.value });
    selected.value = result.data; updateJob(result.data); section.value = 'history'; pollFailed.value = false; poll();
  } catch (error) { issue.value = errorMessage(error); if (error instanceof ApiError && error.status === 409) complete.value = false; }
  finally { busy.value = false; }
}
async function retrySelected() {
  if (!selected.value) return;
  busy.value = true; issue.value = '';
  try { const result = await api.request<ReleaseJob>(`/admin/releases/${selected.value.id}/retry`, { method: 'POST', body: {} }); selected.value = result.data; updateJob(result.data); pollFailed.value = false; poll(); }
  catch (error) { issue.value = errorMessage(error); }
  finally { busy.value = false; }
}
async function preview() {
  if (!selected.value) return;
  busy.value = true; issue.value = '';
  const popup = window.open('about:blank', '_blank');
  try {
    const response = await api.request<{ previewUrl: string }>(`/admin/releases/${selected.value.id}/preview`, { method: 'POST', body: {} });
    const url = new URL(response.data.previewUrl, window.location.origin);
    if (url.origin !== window.location.origin) throw new Error('预览地址未通过校验。');
    if (popup) { popup.opener = null; popup.location.replace(url.href); }
    else issue.value = '浏览器阻止了新窗口。已开启预览，可以从侧栏打开网站查看。';
    emit('preview', selected.value.releaseId ?? selected.value.id);
  } catch (error) { popup?.close(); issue.value = errorMessage(error); }
  finally { busy.value = false; }
}
async function activate() {
  if (!selected.value) return;
  const fresh = selected.value.status === 'ready';
  if (!window.confirm(fresh ? `确认一次发布这 ${selected.value.changes?.length ?? 0} 项改动？网站将整体切换到已预览的候选版本。` : '确认恢复这个历史版本？公开内容会整体恢复到当时的版本，当前草稿仍保留。')) return;
  busy.value = true; issue.value = '';
  try {
    const result = await api.request<ReleaseJob>(`/admin/releases/${selected.value.id}/activate`, { method: 'POST', body: { expectedReleaseId: activeId.value } });
    selected.value = result.data; await loadJobs(); updateJob(result.data); emit('activated'); complete.value = false; pollFailed.value = false; poll();
  } catch (error) { issue.value = errorMessage(error); }
  finally { busy.value = false; }
}
onMounted(() => { dialog.value?.showModal(); void loadWorkspace(); });
onBeforeUnmount(() => { alive = false; loadSequence++; controller.abort(); if (timer) clearTimeout(timer); dialog.value?.close(); });
</script>
<template>
  <dialog ref="dialog" class="release-dialog release-center" aria-labelledby="release-heading" @cancel.prevent="emit('close')">
    <div class="dialog-head"><div><p class="eyebrow">PUBLISH TOGETHER</p><h2 id="release-heading">发布中心</h2></div><button type="button" aria-label="关闭发布窗口" @click="emit('close')">关闭</button></div>
    <div class="dialog-content">
      <p class="hint">各处保存草稿后，在这里汇总选择，一起生成预览、一次发布。未保存的编辑不会进入清单。</p>
      <div class="tabs mt16" role="tablist" aria-label="发布管理"><button role="tab" :aria-selected="section === 'changes'" :class="{ active: section === 'changes' }" @click="section = 'changes'">待发布改动 <span v-if="complete">{{ pending.length }}</span></button><button role="tab" :aria-selected="section === 'history'" :class="{ active: section === 'history' }" @click="section = 'history'">发布记录</button></div>
      <div v-if="issue" class="notice error mt16" role="alert">{{ issue }} <button v-if="section === 'changes' && !busy" type="button" @click="loadWorkspace">重新读取清单</button></div>
      <section v-if="section === 'changes'" aria-label="待发布改动">
        <p v-if="loading" class="loading" role="status">正在汇总各模块已保存内容… 已读取 {{ candidates.length }} 项</p>
        <template v-else>
          <div class="release-controls mt24"><label class="search"><span class="sr-only">搜索待发布内容</span><input v-model="search" type="search" placeholder="搜索内容标题" :disabled="!complete"></label><select v-model="filter" aria-label="发布清单筛选"><option value="pending">待发布改动</option><option v-for="collection in releaseCollections" :key="collection" :value="collection">{{ collectionLabels[collection] }}</option><option value="hidden">已隐藏内容</option><option value="all">所有已保存内容</option></select><button type="button" :disabled="busy" @click="loadWorkspace">刷新清单</button></div>
          <div class="release-selection mt16"><strong>已选 {{ selectedChanges.length }} 项</strong><button type="button" :disabled="!complete || busy" @click="selectPending">全选待发布（{{ pending.length }}）</button><button type="button" :disabled="busy" @click="choices = {}">取消全选</button></div>
          <p class="hint mt8">已隐藏内容默认不选。每个版本最多 {{ MAX_RELEASE_CHANGES }} 项；后台分步处理，公开版本一次切换。</p>
          <p v-if="!complete" class="notice error mt16">清单尚未完整读取，暂不能生成版本。请重新读取清单。</p>
          <div v-if="!filtered.length && complete" class="empty mt24"><h3>{{ candidates.length ? '当前筛选下没有内容' : '还没有已保存内容' }}</h3><p>{{ candidates.length ? '所有已保存的待发布改动都已汇总，可切换筛选查看其他内容。' : '先在创作、摄影等模块保存草稿，再回到这里。' }}</p></div>
          <ul v-else class="candidate-list mt24"><li v-for="item in filtered" :key="changeKey(item)"><label class="candidate-check"><input type="checkbox" :checked="!!choices[changeKey(item)]" :disabled="!complete || busy" :aria-label="`选择${collectionLabels[item.collection]}：${item.title}`" @change="toggle(item, ($event.target as HTMLInputElement).checked)"><span><strong>{{ item.title }}</strong><small>{{ collectionLabels[item.collection] }} · 版本 {{ item.version }} · {{ changeLabels[item.changeKind] }}</small></span></label><select v-if="choices[changeKey(item)] && item.actions.length > 1" v-model="choices[changeKey(item)]" :aria-label="`${item.title}的发布操作`" :disabled="busy"><option value="publish">{{ item.changeKind === 'hidden' ? '重新公开' : '发布' }}</option><option value="hide">隐藏</option></select><span v-else-if="choices[changeKey(item)]" class="badge">{{ item.changeKind === 'hidden' ? '重新公开' : '发布' }}</span></li></ul>
          <div class="release-submit mt24"><p v-if="selectedChanges.length > MAX_RELEASE_CHANGES" class="error-text" role="alert">已选 {{ selectedChanges.length }} 项，超过单个版本的 {{ MAX_RELEASE_CHANGES }} 项上限。请减少选择；不会自动遗漏或分成多次公开。</p><p v-if="selectedHidden" class="error-text">本次会重新公开 {{ selectedHidden }} 项已隐藏内容。</p><details v-if="selectedItems.length" class="selected-summary"><summary>查看全部 {{ selectedItems.length }} 项已选改动</summary><ul><li v-for="item in selectedItems" :key="changeKey(item)">{{ collectionLabels[item.collection] }} · {{ item.title }} · 版本 {{ item.version }} · {{ choices[changeKey(item)] === 'hide' ? '隐藏' : '发布' }}</li></ul></details><button type="button" class="primary" :disabled="busy || !complete || !selectedChanges.length || selectedChanges.length > MAX_RELEASE_CHANGES" @click="create">{{ busy ? '正在提交…' : `生成 ${selectedChanges.length} 项改动的预览` }}</button><p class="hint">生成后先检查整个网站，再确认一次发布。</p></div>
        </template>
      </section>
      <section v-else aria-label="发布记录">
        <section v-if="selected" class="panel mt24"><div class="flex between"><h3>{{ selected.changes?.length ?? 0 }} 项改动的版本</h3><span class="badge">{{ statusLabel(selected) }}</span></div><p class="hint mt16">创建于 {{ dateTime(selected.createdAt) }}</p><details class="mt8"><summary class="hint">版本编号与变更范围</summary><p class="mono mt8">{{ selected.releaseId ?? selected.id }}</p><ul class="change-list"><li v-for="change in selected.changes" :key="changeKey(change)">{{ collectionLabels[change.collection as keyof typeof collectionLabels] ?? change.collection }} · {{ candidates.find(item => changeKey(item) === changeKey(change))?.title ?? change.id }} · 版本 {{ change.version }} · {{ change.action === 'hide' ? '隐藏' : '发布' }}</li></ul></details>
          <div v-if="selected.status === 'failed'" class="notice error mt16">{{ selected.error?.message ?? '候选版本未通过生成或校验，请检查内容与媒体后重新生成。' }}</div>
          <div v-if="selected.status === 'queued' && selected.dispatchState === 'unconfirmed'" class="notice error mt16"><p>发布任务已保存，尚未确认构建启动。重试会继续同一任务。</p><button type="button" :disabled="busy" @click="retrySelected">重新启动构建</button></div>
          <p v-if="selected.status === 'ready' && selected.previousReleaseId !== activeId" class="notice error mt16">此候选生成后已有其他版本上线。请返回改动清单，重新生成预览。</p>
          <div v-if="['ready', 'live', 'superseded'].includes(selected.status)" class="flex mt24"><button type="button" :disabled="busy" @click="preview">打开私有预览 ↗</button><button type="button" class="primary" :disabled="busy || selected.id === activeId || selected.status === 'ready' && selected.previousReleaseId !== activeId" @click="activate">{{ selected.status === 'ready' ? `确认一次发布 ${selected.changes?.length ?? 0} 项` : '恢复此版本' }}</button></div>
          <p v-if="releaseNeedsPolling(selected)" class="hint mt16" role="status">{{ selected.status === 'live' ? `网站已更新，正在同步后台记录 ${selected.reconciledRecords ?? 0} / ${selected.changes?.length ?? 0}` : '后台正在生成和校验页面。可以关闭窗口，稍后从发布记录继续。' }}</p>
          <button v-if="pollFailed || selected.status === 'live' && releaseNeedsPolling(selected)" type="button" class="mt16" :disabled="busy" @click="refreshSelected">继续读取进度</button>
        </section>
        <div class="flex between mt32"><h3>发布记录</h3><button type="button" :disabled="busy || loadingMore" @click="loadMoreJobs">{{ nextJobCursor ? '加载更多记录' : '刷新记录' }}</button></div><p class="hint mt8">当前公开版本：<span class="mono">{{ activeId ?? '尚未发布' }}</span></p><p v-if="loading" class="loading">正在读取发布记录…</p><div v-else-if="!jobs.length" class="empty mt16">还没有发布记录。</div><ul v-else class="release-list mt16"><li v-for="job in sortedJobs" :key="job.id"><button type="button" :class="{ selected: selected?.id === job.id }" @click="selectJob(job)"><span><strong>{{ job.changes?.length ?? 0 }} 项改动</strong><small>{{ dateTime(job.createdAt) }}</small></span><span class="badge">{{ statusLabel(job) }}</span></button></li></ul>
      </section>
    </div>
  </dialog>
</template>
<style scoped>
.release-controls select{width:auto;flex:0 1 200px}.release-controls>button{flex-shrink:0}.selected-summary{font-size:12px}.selected-summary ul{max-height:180px;overflow:auto;padding:12px 0 0 18px;line-height:1.9;overflow-wrap:anywhere}
.release-center{max-width:980px;width:min(980px,calc(100vw - 24px))}.release-controls{display:flex;gap:12px;flex-wrap:wrap}.release-controls .search{flex:1;min-width:180px}.release-controls input{width:100%}.release-selection{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.release-selection strong{margin-right:auto;font-size:15px}.candidate-list{list-style:none;padding:0;border-top:1px solid var(--line)}.candidate-list li{display:flex;align-items:center;gap:16px;padding:18px 4px;border-bottom:1px solid var(--line)}.candidate-check{display:flex;align-items:center;gap:14px;flex:1;min-width:0;cursor:pointer}.candidate-check input{width:18px;height:18px;min-height:18px;accent-color:var(--green);flex-shrink:0}.candidate-check strong{font-size:14px;overflow-wrap:anywhere}.candidate-check small{display:block;font-size:11px;line-height:1.7;color:var(--muted);margin-top:4px}.candidate-list select{width:auto;min-width:96px;flex-shrink:0}.release-submit{position:sticky;bottom:-28px;padding:20px 0 10px;background:var(--paper);border-top:1px solid var(--line);display:grid;gap:10px}.release-submit>button{justify-self:start;min-width:240px}.release-center .mono{overflow-wrap:anywhere}.release-center .flex{flex-wrap:wrap}@media(max-width:600px){.release-selection{gap:8px}.candidate-list li{gap:8px}.candidate-check{gap:10px}.candidate-check strong{font-size:13px}.candidate-check small{font-size:10px}.candidate-list select{min-width:76px;padding-inline:7px;font-size:12px}.release-controls select{flex:1}.release-submit{bottom:-20px}.release-submit>button{width:100%;min-width:0}.release-selection button{padding-inline:10px;font-size:11px}.release-center .tabs{gap:12px}}
</style>
