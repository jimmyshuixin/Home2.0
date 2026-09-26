<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { BilibiliProfileSchema, GitHubProfileSchema, type BilibiliProfile, type GitHubProfile } from '@xvyin/contracts';
import { api, dateTime } from '../api';

const bilibili = ref<BilibiliProfile | null>(null), github = ref<GitHubProfile | null>(null);
const bilibiliIssue = ref(''), githubIssue = ref(''), loading = ref(false);
let controller: AbortController | undefined;
const platforms = computed(() => [
  { name: 'Bilibili', account: 'UID 520237303', profile: bilibili.value, issue: bilibiliIssue.value, collection: '作品', collectionUpdatedAt: bilibili.value?.worksUpdatedAt, count: bilibili.value?.works?.length },
  { name: 'GitHub', account: '@jimmyshuixin', profile: github.value, issue: githubIssue.value, collection: '精选项目', collectionUpdatedAt: github.value?.repositoriesUpdatedAt, count: github.value?.repositories?.length },
]);
function statusLabel(status?: string) {
  return ({ fresh: '已更新', stale: '暂未更新，保留上次资料', snapshot: '公开资料快照', unavailable: '资料暂不可用' } as Record<string, string>)[status || ''] || '尚未读取';
}
async function load() {
  if (loading.value) return;
  loading.value = true; bilibiliIssue.value = ''; githubIssue.value = '';
  const requestController = new AbortController(); controller = requestController;
  const timeout = setTimeout(() => requestController.abort(), 15000);
  try {
    const results = await Promise.allSettled([
      api.request<unknown>('/bilibili/profile', { signal: requestController.signal }).then(result => BilibiliProfileSchema.parse(result.data)),
      api.request<unknown>('/github/profile', { signal: requestController.signal }).then(result => GitHubProfileSchema.parse(result.data)),
    ]);
    if (controller !== requestController) return;
    if (results[0].status === 'fulfilled') bilibili.value = results[0].value;
    else bilibiliIssue.value = '本次读取失败，请稍后重新读取。';
    if (results[1].status === 'fulfilled') github.value = results[1].value;
    else githubIssue.value = '本次读取失败，请稍后重新读取。';
  } finally {
    clearTimeout(timeout);
    if (controller === requestController) { loading.value = false; controller = undefined; }
  }
}
onMounted(load);
onBeforeUnmount(() => { controller?.abort(); controller = undefined; });
</script>

<template>
  <section class="panel platform-sync mt40" aria-labelledby="platform-sync-title" :aria-busy="loading">
    <div class="sync-heading"><div><p class="eyebrow">PUBLIC PROFILES · 公开资料</p><h2 id="platform-sync-title">平台数据同步状态</h2></div><button type="button" :disabled="loading" @click="load">{{ loading ? '正在读取…' : '重新读取状态' }}</button></div>
    <p class="hint mt16">B 站与 GitHub 的公开资料由平台定时同步，在这里查看当前资料和更新时间。无需登录或扫码绑定平台账号。</p>
    <div class="sync-platforms mt24">
      <article v-for="platform in platforms" :key="platform.name" class="sync-platform">
        <div class="sync-identity"><h3>{{ platform.name }}</h3><span class="mono hint">{{ platform.account }}</span></div>
        <p class="sync-status" role="status">{{ platform.issue ? '本次读取未完成' : loading && !platform.profile ? '正在读取…' : statusLabel(platform.profile?.status) }}</p>
        <dl class="sync-meta"><div><dt>资料最近更新</dt><dd>{{ dateTime(platform.profile?.updatedAt ?? undefined) }}</dd></div><div><dt>{{ platform.collection }}最近更新</dt><dd>{{ dateTime(platform.collectionUpdatedAt ?? undefined) }}</dd></div></dl>
        <p v-if="platform.count !== undefined" class="hint mt16">已收录 {{ platform.count }} {{ platform.name === 'Bilibili' ? '部公开作品' : '个公开项目' }}。</p>
        <p v-if="platform.issue" class="notice error mt16" role="alert">{{ platform.issue }}<template v-if="platform.profile">以上保留上次读取的记录。</template></p>
      </article>
    </div>
    <p class="hint mt16">时间均为北京时间。重新读取仅查看同步结果；抖音当前展示主页入口和已收录的公开视频，资料与统计未自动同步。</p>
  </section>
</template>

<style scoped>
.platform-sync{min-width:0}.sync-heading{display:flex;align-items:center;justify-content:space-between;gap:20px}.sync-heading>button{flex-shrink:0}.sync-platforms{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px}.sync-platform{min-width:0}.sync-platform+.sync-platform{border-left:1px solid var(--line);padding-left:28px}.sync-identity{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px}.sync-identity h3{font-size:19px;font-weight:500}.sync-status{font-size:13px;color:var(--green);margin-top:12px}.sync-meta{display:grid;gap:14px;margin:18px 0 0}.sync-meta dt{font-size:11px;color:var(--muted)}.sync-meta dd{margin:4px 0 0;font-size:13px;overflow-wrap:anywhere}
@media(max-width:650px){.sync-heading{align-items:flex-start;flex-wrap:wrap;gap:16px}.sync-platforms{grid-template-columns:1fr;gap:24px}.sync-platform+.sync-platform{border-left:0;border-top:1px solid var(--line);padding:24px 0 0}}
</style>
