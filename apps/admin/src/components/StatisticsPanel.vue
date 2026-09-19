<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { shanghaiDate, type AnalyticsReport } from '@xvyin/contracts';
import { api, dateTime, errorMessage } from '../api';

const today = shanghaiDate(Date.now());
const date = ref(today), report = ref<AnalyticsReport | null>(null), cursor = ref<string>(), busy = ref(false), issue = ref('');
const cursors = ref<Array<string | undefined>>([undefined]);
const page = computed(() => cursors.value.length);
const earliest = new Date(Date.parse(`${today}T00:00:00Z`) - 365 * 86400_000).toISOString().slice(0, 10);
const paths = computed(() => [...(report.value?.summary.paths || [])].sort((a, b) => b.views - a.views));
const highest = computed(() => Math.max(1, ...(report.value?.history.map(day => day.pageViews) || [])));
let sequence = 0, controller: AbortController | undefined;
function duration(ms: number): string { const seconds = Math.floor(ms / 1000); return seconds >= 3600 ? `${Math.floor(seconds / 3600)} 时 ${Math.floor(seconds % 3600 / 60)} 分` : seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`; }
async function load(reset = true) {
  if (reset) cursors.value = [undefined];
  if (report.value?.summary.date !== date.value) report.value = null;
  const current = ++sequence; controller?.abort(); controller = new AbortController(); busy.value = true; issue.value = '';
  const params = new URLSearchParams({ date: date.value }); const currentCursor = cursors.value.at(-1); if (currentCursor) params.set('cursor', currentCursor);
  try { const result = await api.request<AnalyticsReport>(`/admin/analytics?${params}`, { signal: controller.signal }); if (current !== sequence) return; report.value = result.data; cursor.value = result.meta.nextCursor; }
  catch (error) { if (current === sequence && !(error instanceof DOMException && error.name === 'AbortError')) issue.value = errorMessage(error); }
  finally { if (current === sequence) busy.value = false; }
}
function next() { if (!cursor.value || busy.value) return; cursors.value.push(cursor.value); load(false); }
function previous() { if (page.value <= 1 || busy.value) return; cursors.value.pop(); load(false); }
onMounted(() => load()); onBeforeUnmount(() => { sequence++; controller?.abort(); });
</script>

<template>
  <div class="traffic-panel">
    <div class="toolbar"><label class="traffic-date">统计日期（北京时间）<input v-model="date" type="date" :min="earliest" :max="today" @change="load()"></label><button :disabled="busy" @click="load()">{{ busy ? '正在读取…' : '刷新统计' }}</button></div>
    <p v-if="issue" class="notice error mt24" role="alert">{{ issue }}</p>
    <template v-if="report">
      <div class="stats-grid mt24">
        <div class="stat-card"><span>页面浏览</span><strong>{{ report.summary.pageViews }}</strong><small>该日已记录的打开次数</small></div>
        <div class="stat-card"><span>独立访客</span><strong>{{ report.summary.visitors }}</strong><small>按浏览器匿名标识去重</small></div>
        <div class="stat-card"><span>平均前台停留</span><strong class="duration-stat">{{ duration(report.summary.pageViews ? report.summary.activeMs / report.summary.pageViews : 0) }}</strong><small>只累计可见且有焦点的时间</small></div>
        <div class="stat-card"><span>新增点赞</span><strong>{{ report.summary.likesAdded }}</strong><small>该日新增点赞操作次数</small></div>
      </div>
      <p v-if="report.limits.limited" class="notice mt24" role="status">今日免费保护额度已达到上限，后续访问可能未记录。公开内容仍可正常浏览。</p>
      <div class="dashboard-grid mt24">
        <section class="panel"><h2>近七天浏览趋势</h2><div class="traffic-history"><div v-for="day in report.history" :key="day.date" class="traffic-day"><span>{{ day.date.slice(5) }}</span><progress :value="day.pageViews" :max="highest" :aria-label="`${day.date} 浏览 ${day.pageViews} 次`"></progress><strong>{{ day.pageViews }}</strong></div></div><p class="hint mt16">每日汇总保留一年。统计从本功能启用后开始积累。</p></section>
        <section class="panel"><h2>免费服务保护</h2><p class="space-total mt24"><strong>{{ report.limits.writesUsed }}</strong><span>/ {{ report.limits.dailyWriteLimit }} 次今日写入</span></p><progress class="quota-progress mt24" :value="report.limits.writesUsed" :max="report.limits.dailyWriteLimit"></progress><p class="hint mt16">访问与点赞共用每日写入保护额度；每次访问更新或点赞会产生多次数据库写入。每日最多记录 {{ report.limits.maxVisitsPerDay }} 次页面访问，为内容发布保留免费额度。</p></section>
      </div>
      <section class="panel mt24"><h2>浏览的具体内容</h2><p class="hint mt8">已记录的前 40 个页面，按浏览次数排序。</p><div v-if="paths.length" class="traffic-scroll mt24"><table><thead><tr><th>内容</th><th>页面浏览</th><th>累计停留</th></tr></thead><tbody><tr v-for="item in paths" :key="item.path"><td><a :href="item.path" target="_blank" rel="noopener">{{ item.title }} ↗</a><small class="mono">{{ item.path }}</small></td><td>{{ item.views }}</td><td>{{ duration(item.activeMs) }}</td></tr></tbody></table></div><p v-else class="hint mt24">这一天还没有已记录的浏览。</p></section>
      <section class="panel mt24"><div class="flex between"><h2>访客访问明细</h2><span class="hint">第 {{ page }} 页 · 每页 25 条</span></div><p class="hint mt16">IP 与约略国家、省区、城市只供管理员查看；不表示真实身份或精确位置。明细保留不超过 {{ report.limits.retentionDays }} 天，定时任务删除过期记录。未回传结束事件的停留时长可能不完整。</p>
        <div v-if="report.visits.length" class="traffic-scroll mt24"><table><thead><tr><th>访问时间</th><th>IP / 约略位置</th><th>内容</th><th>前台停留</th><th>状态</th></tr></thead><tbody><tr v-for="visit in report.visits" :key="visit.id"><td>{{ dateTime(visit.startedAt) }}</td><td><span class="mono">{{ visit.ip || '未取得 IP' }}</span><small>{{ [visit.country, visit.region, visit.city].filter(Boolean).join(' · ') || '位置未知' }}</small></td><td><a :href="visit.path" target="_blank" rel="noopener">{{ visit.title }} ↗</a><small class="mono">{{ visit.path }}</small></td><td>{{ duration(visit.activeMs) }}</td><td>{{ visit.ended ? '已结束' : '截至最近回传' }}</td></tr></tbody></table></div>
        <p v-else class="hint mt24">{{ report.limits.detailAvailable ? '当前页没有访问记录。' : report.summary.pageViews ? '这一天的访问明细已到期清理，仅保留汇总。' : '这一天没有访问记录。' }}</p>
        <div class="flex mt24"><button :disabled="busy || page <= 1" @click="previous">上一页</button><button :disabled="busy || !cursor" @click="next">下一页</button></div>
      </section>
      <p class="hint mt24">访客可以关闭访问统计，浏览器的 Do Not Track / Global Privacy Control 也会受到尊重。广告拦截、退出过快、后台关闭和额度保护都可能使统计少于实际访问；匿名标识可被清除，因此独立访客和点赞不等同于真实人数。</p>
    </template>
    <p v-else-if="busy" class="loading mt24" role="status">正在读取访问统计…</p>
  </div>
</template>

<style scoped>
.traffic-date{display:grid;gap:8px;color:var(--muted,#76746d);font-size:13px}.traffic-date input{width:180px}.duration-stat{font-size:25px!important}.traffic-history{display:grid;gap:14px;margin-top:24px}.traffic-day{display:grid;grid-template-columns:54px 1fr 36px;align-items:center;gap:14px;font-size:13px}.traffic-day progress{width:100%;height:9px;accent-color:#8e473b}.traffic-day strong{text-align:right}.traffic-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px;text-align:left}th{color:var(--muted,#76746d);font-weight:500;white-space:nowrap}td,th{padding:14px 16px 14px 0;border-bottom:1px solid #dedbd5;vertical-align:top}td small{display:block;margin-top:7px;color:var(--muted,#76746d);font-size:11px;max-width:360px;overflow-wrap:anywhere}td .mono{white-space:nowrap}td:first-child{min-width:126px}td:nth-child(2){min-width:150px}.traffic-panel .hint{line-height:1.8}.traffic-panel .stat-card{cursor:default}
</style>
