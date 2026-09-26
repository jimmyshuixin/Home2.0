<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { BILIBILI_PROFILE_URL, BILIBILI_UID } from '@xvyin/contracts';
import { api, dateTime } from '../api';
import { BilibiliBindingController, emptyBindingView } from '../bilibili-binding';

const view = ref(emptyBindingView());
const controller = new BilibiliBindingController(api, state => { view.value = state; });
const qrImage = ref(''), qrIssue = ref(''), qrRendering = ref(false), now = ref(Date.now());
let renderGeneration = 0;
let clock: ReturnType<typeof setInterval> | undefined;
const statusLabel = computed(() => view.value.binding?.state === 'bound' ? '已绑定' : view.value.binding?.state === 'expired' ? '登录态已过期' : '未绑定');
const secondsLeft = computed(() => view.value.qr ? Math.max(0, Math.ceil((Date.parse(view.value.qr.expiresAt) - now.value) / 1000)) : 0);
const pollingMessage = computed(() => view.value.qrState === 'scanned' ? '已扫码，请在 B 站 App 确认登录。' : '请用 B 站 App 扫码，并确认登录。');
const syncIssue = computed(() => ({ 'partial-sync': '部分资料暂未更新', 'upstream-unavailable': 'B 站暂未返回可用资料', 'credentials-expired': 'B 站登录态已失效' } as Record<string, string>)[view.value.binding?.lastError || ''] || (view.value.binding?.lastError ? '本次同步未完成' : ''));
const statistics = computed(() => [
  { label: '粉丝', value: view.value.binding?.profile?.followers },
  { label: '投稿', value: view.value.binding?.profile?.videoCount },
  { label: '获赞', value: view.value.binding?.profile?.likes },
]);
watch(() => view.value.qr, async qr => {
  const generation = ++renderGeneration;
  qrImage.value = ''; qrIssue.value = ''; qrRendering.value = Boolean(qr);
  if (!qr) return;
  try {
    const { default: QRCode } = await import('qrcode');
    const image = await QRCode.toDataURL(qr.qrUrl, { width: 280, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#17251cff', light: '#ffffffff' } });
    if (generation === renderGeneration) qrImage.value = image;
  } catch {
    if (generation === renderGeneration) qrIssue.value = '二维码无法在本机生成，请重新生成或刷新后台页面。';
  } finally { if (generation === renderGeneration) qrRendering.value = false; }
});
function unlink() {
  if (window.confirm('解除 B 站绑定会删除本站保存的登录凭据并停止自动同步。需要时可重新扫码绑定。继续吗？')) void controller.mutate('unlink');
}
onMounted(() => { void controller.load(); clock = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => { renderGeneration++; clearInterval(clock); qrImage.value = ''; controller.dispose(); });
</script>

<template>
  <section class="panel bilibili-binding mt40" aria-labelledby="bilibili-binding-title" :aria-busy="Boolean(view.busy)">
    <div class="binding-heading"><div><p class="eyebrow">BILIBILI · 个人账号</p><h2 id="bilibili-binding-title">我的 B 站账号</h2></div><a :href="BILIBILI_PROFILE_URL" target="_blank" rel="noopener noreferrer">查看 B 站主页 ↗</a></div>
    <p class="hint mt16">绑定 UID {{ BILIBILI_UID }}，在网站展示公开资料、作品和可用统计。这是个人账号扫码登录接入，非 B 站官方 OAuth 授权。</p>
    <p class="hint mt8">扫码后登录态由服务端加密保存，用于自动同步展示；本站不会执行投稿、评论、点赞或账户修改。请仅使用你自己的账号扫码，之后可随时解绑。</p>
    <p v-if="view.busy === 'loading' && !view.binding" class="loading mt16" role="status">正在读取 B 站绑定状态…</p>
    <div v-if="view.binding && !view.binding.configured" class="notice mt16" role="status">服务端尚未配置 B 站凭据加密密钥，扫码绑定暂不可用。完成服务端配置后，点击“重新读取状态”。</div>
    <div v-if="view.binding" class="binding-details mt24">
      <div class="binding-identity"><strong>{{ view.binding.profile?.name || 'UID ' + BILIBILI_UID }}</strong><span class="binding-state" :class="{ linked: view.binding.state === 'bound' }">{{ statusLabel }}</span></div>
      <dl class="binding-meta"><div><dt>绑定时间</dt><dd>{{ dateTime(view.binding.linkedAt ?? undefined) }}</dd></div><div><dt>登录态有效期</dt><dd>{{ dateTime(view.binding.credentialsExpireAt ?? undefined) }}</dd></div><div><dt>资料最近同步</dt><dd>{{ dateTime(view.binding.lastSyncAt ?? undefined) }}</dd></div><div><dt>作品最近同步</dt><dd>{{ dateTime(view.binding.worksUpdatedAt ?? undefined) }}</dd></div></dl>
      <div v-if="view.binding.profile" class="binding-statistics"><span v-for="stat in statistics" :key="stat.label"><strong>{{ stat.value == null ? '—' : stat.value.toLocaleString('zh-CN') }}</strong> {{ stat.label }}</span><span><strong>{{ view.binding.works.length }}</strong> 部已同步作品</span></div>
      <p v-if="view.binding.lastError" class="notice error mt16" role="status">最近一次同步：{{ syncIssue }}。可手动重试；如登录态失效，请重新扫码。</p>
      <p v-if="view.binding.state === 'expired'" class="notice mt16" role="status">B 站登录态已失效，自动同步已暂停。重新扫码后可继续同步。</p>
    </div>
    <div class="binding-actions mt24">
      <button type="button" class="primary" :disabled="Boolean(view.busy) || !view.binding?.configured" @click="controller.start()">{{ view.busy === 'starting' ? '正在生成二维码…' : view.qr ? '重新生成二维码' : view.binding?.state === 'bound' ? '重新扫码登录' : '扫码绑定 B 站' }}</button>
      <button type="button" :disabled="Boolean(view.busy) || Boolean(view.qr) || !view.binding?.configured || view.binding.state !== 'bound'" @click="controller.mutate('sync')">{{ view.busy === 'syncing' ? '正在同步…' : '立即同步' }}</button>
      <button type="button" :disabled="Boolean(view.busy) || Boolean(view.qr)" @click="controller.load()">重新读取状态</button>
      <button v-if="view.binding && view.binding.state !== 'unbound'" type="button" class="danger" :disabled="Boolean(view.busy) || Boolean(view.qr)" @click="unlink">{{ view.busy === 'unlinking' ? '正在解绑…' : '解除绑定' }}</button>
    </div>
    <div v-if="view.qr" class="binding-qr mt24">
      <div class="binding-qr-image"><img v-if="qrImage" :src="qrImage" width="280" height="280" alt="B 站账号登录二维码，请使用自己的 B 站 App 扫码"><span v-else role="status">{{ qrRendering ? '正在本机生成二维码…' : '二维码暂不可用' }}</span></div>
      <div class="binding-qr-copy"><h3>用 B 站 App 扫一扫</h3><p class="mt8" role="status">{{ pollingMessage }}</p><p class="hint mt16">请确认扫码账号的 UID 为 {{ BILIBILI_UID }}。本次登录仅用于本站展示同步。</p><p class="hint mt8">二维码剩余 {{ secondsLeft }} 秒，关闭此页面后停止等待。</p><p v-if="qrIssue" class="notice error mt16" role="alert">{{ qrIssue }}</p><button type="button" class="mt16" @click="controller.cancel()">取消扫码等待</button></div>
    </div>
    <p v-if="view.error" class="notice error mt16" role="alert">{{ view.error }}</p>
    <p v-if="view.notice" class="notice mt16" role="status">{{ view.notice }}</p>
    <p class="hint mt16">此处绑定与同步单独生效，不需要“保存草稿”或发布整站。B 站接口限制或登录失效时，会保留已同步资料并显示更新时间。</p>
  </section>
</template>

<style scoped>
.bilibili-binding{min-width:0}.binding-heading{display:flex;align-items:center;justify-content:space-between;gap:20px}.binding-heading>a{flex-shrink:0;font-size:12px}.binding-identity{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.binding-identity>strong{font-size:18px;font-weight:500}.binding-state{border:1px solid var(--line);border-radius:100px;padding:3px 10px;font-size:12px;color:var(--muted)}.binding-state.linked{background:var(--soft);color:var(--green)}.binding-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 24px;margin:20px 0}.binding-meta>div{min-width:0}.binding-meta dt{font-size:11px;color:var(--muted)}.binding-meta dd{margin:4px 0 0;font-size:13px;overflow-wrap:anywhere}.binding-statistics{display:flex;flex-wrap:wrap;gap:12px 24px;color:var(--muted);font-size:12px}.binding-statistics strong{font:21px/1.2 Georgia,serif;color:var(--green)}.binding-actions{display:flex;flex-wrap:wrap;gap:10px}.binding-qr{display:grid;grid-template-columns:280px minmax(0,1fr);gap:28px;align-items:center;border-top:1px solid var(--line);padding-top:24px}.binding-qr-image{aspect-ratio:1;background:white;display:grid;place-items:center;width:280px;max-width:100%;color:var(--muted);font-size:12px}.binding-qr-image img{display:block;width:100%;height:auto}.binding-qr-copy{min-width:0}.binding-qr-copy>p{overflow-wrap:anywhere}.binding-qr-copy h3{font-size:19px}
@media(max-width:650px){.binding-heading{align-items:flex-start;gap:12px}.binding-meta{grid-template-columns:1fr}.binding-qr{grid-template-columns:1fr;gap:20px}.binding-qr-image{justify-self:center}.binding-qr-copy{text-align:center}.binding-actions>button{flex:1 1 130px}}
</style>
