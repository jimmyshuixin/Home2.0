<script setup lang="ts">
import { GitHubProfileSchema, type GitHubProfile } from '@xvyin/contracts'

const profileUrl = 'https://github.com/jimmyshuixin'
const profile = ref<GitHubProfile | null>(null), pending = ref(true), avatarFailed = ref(false)
const api = useApi(), controller = new AbortController()
const statistics = computed(() => [
  { label: '公开仓库', value: profile.value?.publicRepos },
  { label: '关注者', value: profile.value?.followers },
  { label: '关注', value: profile.value?.following },
])
const repositories = computed(() => profile.value?.repositories?.slice(0, 3) || [])
function dateLabel(value?: string | null, withTime = false) {
  return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } as const : {}) }).format(new Date(value)) : ''
}
onMounted(async () => {
  try { profile.value = GitHubProfileSchema.parse((await api<unknown>('/github/profile', { signal: controller.signal })).data) }
  catch { profile.value = null }
  finally { pending.value = false }
})
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <section class="github-profile" aria-label="我的 GitHub" :aria-busy="pending">
    <div class="github-heading"><p class="github-eyebrow">GITHUB · 开源项目</p><a :href="profileUrl" target="_blank" rel="noopener noreferrer" class="text-link">GitHub 主页 <SiteIcon name="external" :size="16" /></a></div>
    <div class="github-overview">
      <img v-if="profile?.avatarUrl && !avatarFailed" :src="profile.avatarUrl" alt="GitHub 头像" width="72" height="72" referrerpolicy="no-referrer" loading="lazy" @error="avatarFailed = true">
      <span v-else class="github-avatar" aria-hidden="true">码</span>
      <div class="github-identity"><h2>{{ profile?.name || '我在 GitHub' }}</h2><p class="github-handle">@jimmyshuixin</p><p v-if="profile?.bio" class="github-bio">{{ profile.bio }}</p></div>
      <dl class="github-statistics"><div v-for="stat in statistics" :key="stat.label"><dt>{{ stat.label }}</dt><dd>{{ stat.value == null ? '—' : stat.value.toLocaleString('zh-CN') }}</dd></div></dl>
    </div>
    <p class="github-status" role="status"><template v-if="pending">正在读取 GitHub 公开资料…</template><template v-else-if="profile?.status === 'fresh'">公开资料 · 更新于 {{ dateLabel(profile.updatedAt, true) }}（北京时间）</template><template v-else-if="profile?.status === 'stale'">暂时无法更新，显示 {{ dateLabel(profile.updatedAt, true) }}（北京时间）的公开资料。</template><template v-else-if="profile?.status === 'snapshot'">公开资料快照 · 截至 {{ dateLabel(profile.updatedAt, true) }}（北京时间）</template><template v-else>公开资料暂时无法读取，可以前往 GitHub 查看项目。</template></p>
    <div v-if="repositories.length" class="github-projects">
      <div class="github-projects-heading"><h3>精选公开项目</h3><p v-if="profile?.repositoriesUpdatedAt" class="github-status">更新于 {{ dateLabel(profile.repositoriesUpdatedAt, true) }}（北京时间）</p></div>
      <div class="github-project-list"><article v-for="repository in repositories" :key="repository.name" class="github-project">
        <h4><a :href="repository.url" target="_blank" rel="noopener noreferrer">{{ repository.name }}<SiteIcon name="external" :size="16" /></a></h4>
        <p v-if="repository.description" class="github-description">{{ repository.description }}</p>
        <dl class="github-project-meta"><div v-if="repository.language"><dt>语言</dt><dd>{{ repository.language }}</dd></div><div><dt>星标</dt><dd>{{ repository.stars.toLocaleString('zh-CN') }}</dd></div><div><dt>Fork</dt><dd>{{ repository.forks.toLocaleString('zh-CN') }}</dd></div></dl>
        <p v-if="repository.pushedAt" class="github-pushed">最近推送 {{ dateLabel(repository.pushedAt) }}</p>
      </article></div>
      <a :href="`${profileUrl}?tab=repositories`" target="_blank" rel="noopener noreferrer" class="text-link github-more">查看全部公开项目 <SiteIcon name="external" :size="16" /></a>
    </div>
  </section>
</template>

<style scoped>
.github-profile{min-width:0;margin:0 0 clamp(36px,5vw,64px);padding:clamp(22px,3vw,32px) 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.github-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}.github-heading .text-link{font-size:13px;white-space:nowrap}.github-eyebrow{font-size:12px;letter-spacing:.12em;color:var(--muted);margin:0}.github-overview{display:flex;align-items:center;gap:20px}.github-overview>img,.github-avatar{flex:0 0 72px;width:72px;height:72px;object-fit:cover;border-radius:50%}.github-avatar{display:grid;place-items:center;font:38px/1 var(--serif);color:var(--green);background:var(--panel)}.github-identity{min-width:0;flex:1}.github-identity h2{font-size:clamp(23px,3vw,30px);font-weight:400;margin:0;line-height:1.4}.github-handle{font-size:11px;letter-spacing:.06em;color:var(--muted);margin:4px 0 0}.github-bio{font-size:13px;line-height:1.7;overflow-wrap:anywhere;margin:8px 0 0}.github-statistics{display:flex;gap:clamp(24px,4vw,44px);margin:0 0 0 20px}.github-statistics>div{display:flex;flex-direction:column-reverse;gap:7px}.github-statistics dt{font-size:12px;color:var(--muted)}.github-statistics dd{font:clamp(22px,3vw,29px)/1.3 Georgia,serif;font-variant-numeric:tabular-nums;color:var(--green);margin:0;min-width:3ch}.github-status{font-size:11px;color:var(--muted);line-height:1.8;margin:20px 0 0}.github-projects{border-top:1px solid var(--line);margin-top:24px;padding-top:22px}.github-projects-heading{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}.github-projects-heading h3{font-size:16px;font-weight:400;margin:0}.github-projects-heading .github-status{margin:0}.github-project-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px;margin-top:22px}.github-project{min-width:0;padding-right:20px;border-right:1px solid var(--line)}.github-project:last-child{padding-right:0;border:0}.github-project h4{font-size:17px;line-height:1.5;font-weight:400;margin:0 0 12px}.github-project h4 a{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;overflow-wrap:anywhere}.github-project h4 svg{flex-shrink:0;margin-top:4px}.github-description{font-size:12px;line-height:1.9;margin:0 0 16px;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}.github-project-meta{display:flex;flex-wrap:wrap;gap:6px 16px;margin:0;font-size:11px;color:var(--muted)}.github-project-meta>div{display:flex;gap:5px}.github-project-meta dd{margin:0;color:var(--green)}.github-pushed{font-size:11px;color:var(--muted);margin:10px 0 0}.github-more{font-size:12px;margin-top:20px}
@media(max-width:760px){.github-overview{flex-wrap:wrap;gap:16px}.github-overview>img,.github-avatar{flex-basis:60px;width:60px;height:60px}.github-statistics{flex-basis:100%;justify-content:space-between;gap:16px;margin:8px 0 0}.github-statistics>div{min-width:25%}.github-project-list{grid-template-columns:1fr;gap:20px}.github-project{padding:0 0 20px;border-right:0;border-bottom:1px solid var(--line)}.github-project:last-child{padding-bottom:0}.github-project h4{font-size:17px}.github-description{-webkit-line-clamp:3}.github-heading{margin-bottom:18px}}
</style>
