<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ExpiryMaintenanceStatus } from '../../../../workers/api/src/maintenance-expiry-types';
import type { StorageInventoryStatus } from '../../../../workers/api/src/storage-inventory-types';
import { api, dateTime, errorMessage, type Envelope } from '../api';

const expiry = ref<ExpiryMaintenanceStatus | null>(null);
const expiryLoading = ref(false), expiryRunning = ref(false), expiryStopped = ref(false), expiryIssue = ref('');
const storage = ref<StorageInventoryStatus | null>(null);
const storageLoading = ref(false), storageRunning = ref(false), storageStopped = ref(false), storageIssue = ref('');
const keepRecent = ref(5);
let disposed = false;
const stepDelay = () => new Promise<void>(resolve => setTimeout(resolve, 150));
const labels = { sessions: '管理员会话', rates: '限流记录', idempotency: '公开提交去重记录' };
const expiryCategory = computed(() => {
  const category = expiry.value?.phase === 'backfill' ? expiry.value.backfill.collection : expiry.value?.cleanup.collection;
  return category ? labels[category] : '准备检查';
});
const expiryStatus = computed(() => {
  const value = expiry.value;
  if (!value) return '尚未读取维护进度';
  if (expiryRunning.value) return expiryStopped.value ? '正在暂停，等待当前一批完成…' : `${value.phase === 'backfill' ? '正在整理' : '正在检查'}${expiryCategory.value}`;
  if (value.lastResult === 'budget_limited') return '今日维护预算已用完，进度已保留。';
  if (value.busy) return '维护暂时占用中，稍后刷新可查看进度。';
  if (value.phase === 'cleanup' && !value.canAdvance && value.cleanup.lastCompletedAt) return '本轮检查已完成。下次开放后可继续检查新到期记录。';
  if (expiryStopped.value) return '已暂停本页连续维护，已完成的进度会保留。';
  return value.phase === 'backfill' ? '先整理旧记录，再分批检查到期时间。' : '已准备好检查到期记录。';
});
const expiryBudgets = computed(() => {
  const budget = expiry.value?.budget;
  return budget ? [
    { label: '维护步数', used: budget.stepsUsed, limit: budget.stepLimit },
    { label: '读取预留', used: budget.readUnitsReserved, limit: budget.readLimit },
    { label: '写入预留', used: budget.writeUnitsReserved, limit: budget.writeLimit },
    { label: '清理预留', used: budget.deleteUnitsReserved, limit: budget.deleteLimit },
  ] : [];
});
const job = computed(() => storage.value?.job ?? null);
const storageStatus = computed(() => {
  if (storageRunning.value) return storageStopped.value ? '正在暂停，等待当前一批完成…' : '正在逐批盘点存储空间…';
  if (!job.value) return '还没有容量盘点，开始后可查看实际文件数量与大小。';
  if (job.value.busy) return '另一项盘点正在执行，稍后刷新可查看进度。';
  if (storage.value && storage.value.budget.attemptsUsed >= storage.value.budget.attemptsLimit && !['completed', 'limited'].includes(job.value.status)) return '今日盘点预算已用完，进度已保留。';
  return ({ running: '进度已保存，可以继续盘点。', paused: '盘点已暂停，已完成的进度会保留。', failed: '本次盘点中断，已完成的进度会保留。', completed: '本次盘点已完成。', limited: '本次盘点已达到运行上限，已扫描结果保留。' })[job.value.status];
});
const storageCategories = computed(() => {
  const totals = job.value?.totals;
  return totals ? [
    { label: '媒体文件', count: totals.originals.count + totals.variants.count, bytes: totals.originals.bytes + totals.variants.bytes },
    { label: '网站发布', count: totals.releases.count + totals.snapshots.count, bytes: totals.releases.bytes + totals.snapshots.bytes },
    { label: '其他文件', count: totals.other.count, bytes: totals.other.bytes },
  ] : [];
});
const canStartStorage = computed(() => !!storage.value && !storageRunning.value && !storageLoading.value && !job.value?.busy && storage.value.budget.startsUsed < storage.value.budget.startsLimit && storage.value.budget.attemptsUsed < storage.value.budget.attemptsLimit && (!job.value || ['completed', 'limited'].includes(job.value.status)));
const canResumeStorage = computed(() => !!job.value?.canAdvance && !job.value.busy && !storageRunning.value && !storageLoading.value);
function bytesLabel(bytes: number) {
  const unit = bytes >= 1e9 ? 1e9 : bytes >= 1e6 ? 1e6 : bytes >= 1e3 ? 1e3 : 1;
  return `${(bytes / unit).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${{ 1: 'B', 1000: 'KB', 1000000: 'MB', 1000000000: 'GB' }[unit]}`;
}
const retention = computed(() => storage.value?.retention ?? null);
const dispositionLabel = { protect: '建议保留', review_only: '仅供人工审查', unknown: '信息不足，保留' };
function retentionReason(reason: string) { return reason === '历史 live 状态不代表当前公开指针' ? '历史启用状态不代表当前公开版本' : reason; }

async function loadExpiry() {
  if (expiryRunning.value || expiryLoading.value) return;
  expiryLoading.value = true; expiryIssue.value = '';
  try { const result = await api.request<ExpiryMaintenanceStatus>('/admin/maintenance/expiry'); if (!disposed) expiry.value = result.data; }
  catch (error) { if (!disposed) expiryIssue.value = errorMessage(error); }
  finally { expiryLoading.value = false; }
}
async function runExpiry(continuous = true) {
  if (expiryRunning.value || expiryLoading.value || !expiry.value?.canAdvance) return;
  expiryRunning.value = true; expiryStopped.value = false; expiryIssue.value = '';
  try {
    for (let step = 0; step < (continuous ? 200 : 1) && !disposed && !expiryStopped.value; step++) {
      const result = await api.request<ExpiryMaintenanceStatus>('/admin/maintenance/expiry/advance', { method: 'POST', body: {} });
      if (disposed) break;
      expiry.value = result.data;
      if (!result.data.canAdvance) break;
      if (continuous) await stepDelay();
    }
  } catch (error) {
    if (!disposed) {
      expiryIssue.value = errorMessage(error);
      try { const result = await api.request<ExpiryMaintenanceStatus>('/admin/maintenance/expiry'); if (!disposed) expiry.value = result.data; } catch { /* Keep the last confirmed progress and the original failure. */ }
    }
  } finally { expiryRunning.value = false; }
}
async function loadStorage() {
  if (storageRunning.value || storageLoading.value) return;
  storageLoading.value = true; storageIssue.value = '';
  try { const result = await api.request<StorageInventoryStatus>('/admin/maintenance/storage'); if (!disposed) storage.value = result.data; }
  catch (error) { if (!disposed) storageIssue.value = errorMessage(error); }
  finally { storageLoading.value = false; }
}
async function runStorage(start = false, continuous = true) {
  if (storageRunning.value || storageLoading.value || !storage.value || (start ? !canStartStorage.value : !canResumeStorage.value)) return;
  storageRunning.value = true; storageStopped.value = false; storageIssue.value = '';
  try {
    if (start) {
      const result = await api.request<StorageInventoryStatus>('/admin/maintenance/storage/start', { method: 'POST', body: { expectedVersion: storage.value.version, keepRecent: keepRecent.value } });
      if (disposed) return;
      storage.value = result.data;
    }
    for (let step = 0; step < (continuous ? 200 : 1) && !disposed && !storageStopped.value && job.value?.canAdvance; step++) {
      const current: StorageInventoryStatus | null = storage.value;
      if (!current?.job) break;
      const result: Envelope<StorageInventoryStatus> = await api.request<StorageInventoryStatus>('/admin/maintenance/storage/advance', { method: 'POST', body: { jobId: current.job.id, expectedVersion: current.version } });
      if (disposed) break;
      storage.value = result.data;
      if (!result.data.job?.canAdvance || result.data.job.status === 'failed') break;
      if (continuous) await stepDelay();
    }
    const current = storage.value;
    if (!disposed && storageStopped.value && current?.job && !['completed', 'limited'].includes(current.job.status)) {
      const result = await api.request<StorageInventoryStatus>('/admin/maintenance/storage/pause', { method: 'POST', body: { jobId: current.job.id, expectedVersion: current.version } });
      if (!disposed) storage.value = result.data;
    }
  } catch (error) {
    if (!disposed) {
      storageIssue.value = errorMessage(error);
      try { const result = await api.request<StorageInventoryStatus>('/admin/maintenance/storage'); if (!disposed) storage.value = result.data; } catch { /* Keep the last confirmed progress and the original failure. */ }
    }
  } finally { storageRunning.value = false; }
}
onMounted(() => { void loadExpiry(); void loadStorage(); });
onBeforeUnmount(() => { disposed = true; expiryStopped.value = true; storageStopped.value = true; });
</script>

<template>
  <div class="maintenance-grid">
    <section class="panel maintenance-card" aria-labelledby="expiry-maintenance-title">
      <div class="maintenance-heading"><div><p class="eyebrow">日常照看</p><h2 id="expiry-maintenance-title">到期记录维护</h2></div><span class="badge">分批执行</span></div>
      <p class="hint mt16">仅检查管理员会话、限流记录与公开提交去重记录。无法确认到期时间的记录会保留，网站内容和留言不在清理范围内。</p>
      <p class="maintenance-status mt24" role="status">{{ expiryLoading ? '正在读取维护进度…' : expiryStatus }}</p>
      <p v-if="expiryIssue" class="notice error mt16" role="alert">{{ expiryIssue }}</p>
      <template v-if="expiry">
        <div class="maintenance-metrics mt24">
          <div><span>已清理到期记录</span><strong>{{ expiry.cleanup.deleted }}</strong><small>累计完成</small></div>
          <div><span>异常记录保留</span><strong>{{ expiry.backfill.invalid + expiry.cleanup.invalid }}</strong><small>需要另行检查</small></div>
          <div><span>继续保留的有效记录</span><strong>{{ expiry.cleanup.renewed }}</strong><small>到期时间已更新</small></div>
        </div>
        <dl class="maintenance-details mt24">
          <div><dt>当前阶段</dt><dd>{{ expiry.phase === 'backfill' ? '整理旧记录' : '检查到期记录' }} · {{ expiryCategory }}</dd></div>
          <div v-if="expiry.phase === 'backfill'"><dt>整理进度</dt><dd>{{ expiry.backfill.completedCollections }} / 3 类，已扫描 {{ expiry.backfill.scanned }} 条</dd></div>
          <div><dt>最近完成一轮</dt><dd>{{ dateTime(expiry.cleanup.lastCompletedAt ?? undefined) }}</dd></div>
          <div v-if="expiry.retryAt && !expiry.canAdvance"><dt>下次可运行</dt><dd>{{ dateTime(expiry.retryAt) }}，届时可刷新进度</dd></div>
        </dl>
        <div class="maintenance-actions mt24">
          <button v-if="expiryRunning" type="button" :disabled="expiryStopped" @click="expiryStopped = true">{{ expiryStopped ? '正在暂停…' : '暂停维护' }}</button>
          <template v-else><button class="primary" type="button" :disabled="expiryLoading || !expiry.canAdvance" @click="runExpiry()">{{ expiryIssue ? '重试维护' : expiry.backfill.scanned || expiry.phase === 'cleanup' ? '继续维护' : '开始维护' }}</button><button type="button" :disabled="expiryLoading || !expiry.canAdvance" @click="runExpiry(false)">运行一步</button></template>
          <button type="button" :disabled="expiryRunning || expiryLoading" @click="loadExpiry">刷新维护进度</button>
        </div>
        <p class="hint mt8">每步最多检查 {{ expiry.limits.batchSize }} 条。暂停或离开仅停止本页连续维护，自动维护仍会按计划执行；已完成的进度会保留。</p>
        <details class="maintenance-budget mt24"><summary>每日维护预算 · {{ expiry.budget.day }}（UTC）</summary><p class="hint mt8">运行前预留用量，未完成的尝试也会计入预算；达到上限后等待下一预算日。预算按 UTC 日期恢复，即北京时间每日 08:00。</p><dl class="maintenance-details mt16"><div v-for="budget in expiryBudgets" :key="budget.label"><dt>{{ budget.label }}</dt><dd>{{ budget.used }} / {{ budget.limit }}</dd></div></dl></details>
      </template>
      <button v-else class="mt16" type="button" :disabled="expiryLoading" @click="loadExpiry">{{ expiryIssue ? '重试读取维护进度' : '刷新维护进度' }}</button>
    </section>

    <section class="panel maintenance-card" aria-labelledby="storage-inventory-title">
      <div class="maintenance-heading"><div><p class="eyebrow">空间账目</p><h2 id="storage-inventory-title">R2 容量盘点</h2></div><span class="badge">只读盘点</span></div>
      <p class="hint mt16">按实际文件统计媒体、网站发布与其他占用。盘点只读取容量，不删除文件，也不改动正在公开的网站。</p>
      <p class="maintenance-status mt24" role="status">{{ storageLoading ? '正在读取盘点进度…' : storageStatus }}</p>
      <p v-if="storageIssue || job?.lastError" class="notice error mt16" role="alert">{{ storageIssue || job?.lastError?.message }}</p>
      <template v-if="storage">
        <template v-if="job">
          <div class="storage-total mt24"><strong>{{ bytesLabel(job.total.bytes) }}</strong><span>{{ job.total.count }} 个文件 · {{ job.status === 'completed' ? '本次盘点合计' : '已扫描，尚非完整合计' }}</span></div>
          <div class="maintenance-metrics mt24"><div v-for="category in storageCategories" :key="category.label"><span>{{ category.label }}</span><strong>{{ bytesLabel(category.bytes) }}</strong><small>{{ category.count }} 个文件</small></div></div>
          <p v-if="job.status === 'completed' && job.total.count === 0" class="notice mt24">本次盘点未发现存储文件，容量合计为 0 B。</p>
          <dl class="maintenance-details mt24">
            <div><dt>扫描开始</dt><dd>{{ dateTime(job.startedAt) }}</dd></div><div><dt>{{ job.finishedAt ? '扫描结束' : '最近推进' }}</dt><dd>{{ dateTime(job.finishedAt ?? job.updatedAt) }}</dd></div>
            <div><dt>完成状态</dt><dd>{{ job.phase === 'objects' ? '正在统计文件' : job.phase === 'release_records' ? '正在核对发布历史' : '盘点结束' }} · 已扫描 {{ job.r2Pages }} 批文件、{{ job.releaseRecords }} 条发布记录</dd></div>
          </dl>
          <p class="hint mt16">这是上述时间窗内的扫描结果，期间上传或发布可能使实时容量变化。</p>
        </template>
        <section v-if="retention" class="retention-summary mt24" aria-labelledby="retention-plan-title">
          <h3 id="retention-plan-title">历史发布保留建议</h3>
          <p class="hint mt8">参考最近 {{ retention.keepRecent }} 个可预览或已发布版本、扫描时的公开版本与发布状态。共享媒体和历史引用尚未完整核对；这些建议不能用于删除文件。</p>
          <p v-if="!retention.metadataComplete || !retention.objectScanComplete || retention.releaseGroupsTruncated || !retention.recentPolicyComplete" class="notice mt16">扫描或历史信息尚不完整，未知项继续保留。</p>
          <p v-if="!retention.entries.length" class="hint mt16">本次没有可列出的发布历史。</p>
          <details v-for="entry in retention.entries" :key="entry.releaseId" class="retention-entry mt16">
            <summary><span class="badge" :class="{ green: entry.disposition === 'protect' }">{{ dispositionLabel[entry.disposition] }}</span><span class="mono">{{ entry.releaseId }}</span><span>{{ bytesLabel(entry.objects.bytes + entry.snapshots.bytes) }}</span></summary>
            <p class="hint mt8">{{ dateTime(entry.createdAt ?? undefined) }} · {{ entry.objects.count + entry.snapshots.count }} 个文件</p>
            <ul class="hint mt8"><li v-for="reason in entry.reasons" :key="reason">{{ retentionReason(reason) }}</li></ul>
          </details>
          <p v-if="retention.unknownReleaseObjects.count" class="hint mt16">另有 {{ retention.unknownReleaseObjects.count }} 个文件尚无法对应发布记录（{{ bytesLabel(retention.unknownReleaseObjects.bytes) }}），继续保留。</p>
          <p class="hint mt16">容量仅含已完成的存储文件，不含仍在上传的分片；文件大小合计不等同于账单金额或免费额度余量。</p>
        </section>
        <label v-if="!job || ['completed', 'limited'].includes(job.status)" class="field mt24">历史保留参考<select v-model.number="keepRecent" :disabled="storageRunning || storageLoading"><option v-for="count in [3, 5, 10]" :key="count" :value="count">最近 {{ count }} 个可预览或已发布版本</option></select><small class="hint">生成保留建议，不会自动清理任何历史文件。</small></label>
        <div class="maintenance-actions mt24">
          <button v-if="storageRunning" type="button" :disabled="storageStopped" @click="storageStopped = true">{{ storageStopped ? '正在暂停…' : '暂停盘点' }}</button>
          <template v-else><button v-if="!job || ['completed', 'limited'].includes(job.status)" class="primary" type="button" :disabled="!canStartStorage" @click="runStorage(true)">{{ job ? '重新盘点' : '开始盘点' }}</button><template v-else><button class="primary" type="button" :disabled="!canResumeStorage" @click="runStorage()">{{ storageIssue || job.lastError ? '重试盘点' : '继续盘点' }}</button><button type="button" :disabled="!canResumeStorage" @click="runStorage(false, false)">盘点一步</button></template></template>
          <button type="button" :disabled="storageRunning || storageLoading" @click="loadStorage">刷新盘点进度</button>
        </div>
        <p v-if="storage.budget.attemptsUsed >= storage.budget.attemptsLimit || storage.budget.startsUsed >= storage.budget.startsLimit" class="hint mt16">今日{{ storage.budget.attemptsUsed >= storage.budget.attemptsLimit ? '推进' : '新建盘点' }}预算已用完，{{ dateTime(storage.budget.resetsAt) }} 后可刷新继续。</p>
        <details class="maintenance-budget mt24"><summary>每日盘点预算 · {{ storage.budget.day }}（UTC）</summary><dl class="maintenance-details mt16"><div><dt>推进次数</dt><dd>{{ storage.budget.attemptsUsed }} / {{ storage.budget.attemptsLimit }}</dd></div><div><dt>新建盘点</dt><dd>{{ storage.budget.startsUsed }} / {{ storage.budget.startsLimit }}</dd></div><div><dt>预算恢复时间</dt><dd>{{ dateTime(storage.budget.resetsAt) }}</dd></div></dl></details>
      </template>
      <button v-else class="mt16" type="button" :disabled="storageLoading" @click="loadStorage">{{ storageIssue ? '重试读取盘点进度' : '刷新盘点进度' }}</button>
    </section>
  </div>
</template>

<style scoped>
.maintenance-grid{display:grid;gap:24px}.maintenance-card{min-width:0}.maintenance-heading{display:flex;justify-content:space-between;align-items:center;gap:16px}.maintenance-status{font-weight:500;min-height:24px}.maintenance-actions{display:flex;flex-wrap:wrap;gap:10px}.maintenance-actions button{min-height:44px}.maintenance-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.maintenance-metrics>div{min-width:0;padding:18px;background:var(--paper);border-radius:8px}.maintenance-metrics span,.maintenance-metrics small{display:block;font-size:12px;color:var(--muted)}.maintenance-metrics strong{display:block;font-size:25px;font-weight:500;color:var(--green);line-height:1.5;overflow-wrap:anywhere}.maintenance-details{display:grid;gap:12px;font-size:13px}.maintenance-details>div{display:grid;grid-template-columns:150px minmax(0,1fr);gap:16px}.maintenance-details dt{color:var(--muted)}.maintenance-details dd{margin:0;overflow-wrap:anywhere}.maintenance-budget{border-top:1px solid var(--line);padding-top:18px}.maintenance-budget summary{cursor:pointer;min-height:32px;font-size:13px;color:var(--green)}.storage-total{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}.storage-total strong{font:400 36px/1.3 Georgia,serif;color:var(--green)}.storage-total span{font-size:13px;color:var(--muted)}.field select{max-width:290px}.maintenance-card .eyebrow{margin-bottom:6px}.retention-summary{border-top:1px solid var(--line);padding-top:22px}.retention-entry{border:1px solid var(--line);border-radius:7px;padding:14px}.retention-entry summary{display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px;cursor:pointer;font-size:12px;min-height:30px}.retention-entry summary>.mono{flex:1;min-width:140px}.retention-entry ul{padding-left:18px}
@media(max-width:600px){.maintenance-heading{align-items:flex-start;gap:12px}.maintenance-heading .badge{margin-top:5px}.maintenance-card h2{font-size:19px}.maintenance-metrics{grid-template-columns:1fr;gap:10px}.maintenance-metrics>div{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;padding:14px 16px;gap:2px 12px}.maintenance-metrics strong{grid-column:2;grid-row:1/3;font-size:23px}.maintenance-details>div{grid-template-columns:1fr;gap:2px}.maintenance-actions button{flex:1 1 auto}.storage-total{gap:8px}.storage-total strong{font-size:32px}}
</style>
