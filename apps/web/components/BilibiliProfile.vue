<script setup lang="ts">
import { BILIBILI_PROFILE_URL, BILIBILI_UID, BilibiliProfileSchema, type BilibiliProfile } from '@xvyin/contracts'
import { site, ordered } from '~/lib/site'

defineProps<{ showWorks?: boolean }>()
const profile = ref<BilibiliProfile | null>(null)
const pending = ref(true), avatarFailed = ref(false)
const api = useApi(), controller = new AbortController()
const profileUrl = BILIBILI_PROFILE_URL
const works = ordered(site.creations).filter(entry => entry.blocks.some(block => block.type === 'video' && block.providerRef?.provider === 'bilibili'))
const statistics = computed(() => [
  { label: '粉丝', value: profile.value?.followers },
  { label: '投稿', value: profile.value?.videoCount },
  { label: '获赞', value: profile.value?.likes },
])
const updated = computed(() => profile.value?.updatedAt ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(profile.value.updatedAt)) : '')
onMounted(async () => {
  try { profile.value = BilibiliProfileSchema.parse((await api<unknown>('/bilibili/profile', { signal: controller.signal })).data) }
  catch { profile.value = null }
  finally { pending.value = false }
})
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <section class="bilibili-profile" aria-label="我的 B 站" :aria-busy="pending">
    <div class="bilibili-heading"><p class="bilibili-eyebrow">影像的另一页</p><a :href="profileUrl" target="_blank" rel="noopener noreferrer" class="text-link">B 站主页 <SiteIcon name="external" :size="16" /></a></div>
    <div class="bilibili-overview">
      <img v-if="profile?.avatarUrl && !avatarFailed" :src="profile.avatarUrl" alt="B 站头像" width="72" height="72" referrerpolicy="no-referrer" loading="lazy" @error="avatarFailed = true">
      <span v-else class="bilibili-avatar" aria-hidden="true">影</span>
      <div class="bilibili-identity"><h2>{{ profile?.name || '我在 B 站' }}</h2><p class="bilibili-uid">UID {{ BILIBILI_UID }}</p><p v-if="profile?.signature" class="bilibili-signature">{{ profile.signature }}</p></div>
      <dl class="bilibili-statistics"><div v-for="stat in statistics" :key="stat.label"><dt>{{ stat.label }}</dt><dd>{{ stat.value == null ? '—' : stat.value.toLocaleString('zh-CN') }}</dd></div></dl>
    </div>
    <p class="bilibili-status" role="status"><template v-if="pending">正在读取 B 站公开资料…</template><template v-else-if="profile?.status === 'fresh'">公开资料 · 更新于 {{ updated }}（北京时间）</template><template v-else-if="profile?.status === 'stale'">暂时无法更新，显示 {{ updated }}（北京时间）的公开资料。</template><template v-else-if="profile?.status === 'snapshot'">公开资料快照 · 截至 {{ updated }}（北京时间），当前数据请见 B 站主页。</template><template v-else>公开资料暂时无法读取，仍可观看已收录视频或前往 B 站主页。</template></p>
    <div v-if="showWorks && works.length" class="bilibili-works"><p class="bilibili-eyebrow">本站收录 · {{ works.length }} 篇 B 站视频创作</p><NuxtLink v-for="entry in works.slice(0, 3)" :key="entry.id" :to="`/creations/${entry.slug}`"><span>{{ entry.title }}</span><span class="bilibili-watch">站内观看 <SiteIcon name="arrow" :size="16" /></span></NuxtLink><NuxtLink v-if="works.length > 3" to="/creations?format=video" class="text-link">更多站内视频 <SiteIcon name="arrow" :size="16" /></NuxtLink></div>
  </section>
</template>

<style scoped>
.bilibili-profile{min-width:0;margin:0 0 clamp(36px,5vw,64px);padding:clamp(22px,3vw,32px) 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.bilibili-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}.bilibili-heading .text-link{font-size:13px;white-space:nowrap}.bilibili-eyebrow{font-size:12px;letter-spacing:.12em;color:var(--muted);margin:0}
.bilibili-overview{display:flex;align-items:center;gap:20px}.bilibili-overview>img,.bilibili-avatar{flex:0 0 72px;width:72px;height:72px;object-fit:cover;border-radius:50%}.bilibili-avatar{display:grid;place-items:center;font:38px/1 var(--serif);color:var(--green);background:var(--panel)}
.bilibili-identity{min-width:0;flex:1}.bilibili-identity h2{font-size:clamp(23px,3vw,30px);font-weight:400;margin:0;line-height:1.4}.bilibili-uid{font-size:11px;letter-spacing:.06em;color:var(--muted);margin:4px 0 0}.bilibili-signature{font-size:13px;line-height:1.7;overflow-wrap:anywhere;margin:8px 0 0}
.bilibili-statistics{display:flex;gap:clamp(24px,4vw,44px);margin:0 0 0 20px}.bilibili-statistics>div{display:flex;flex-direction:column-reverse;gap:7px}.bilibili-statistics dt{font-size:12px;color:var(--muted)}.bilibili-statistics dd{font:clamp(22px,3vw,29px)/1.3 Georgia,serif;font-variant-numeric:tabular-nums;color:var(--green);margin:0;min-width:3ch}
.bilibili-status{font-size:11px;color:var(--muted);line-height:1.8;margin:20px 0 0}.bilibili-works{border-top:1px solid var(--line);margin-top:20px;padding-top:20px}.bilibili-works>a{display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:48px;padding:12px 0;font-size:15px;line-height:1.6}.bilibili-watch{display:flex;align-items:center;gap:8px;flex-shrink:0;font-size:12px;color:var(--green)}
@media(max-width:760px){.bilibili-overview{flex-wrap:wrap;gap:16px}.bilibili-overview>img,.bilibili-avatar{flex-basis:60px;width:60px;height:60px}.bilibili-statistics{flex-basis:100%;justify-content:space-between;gap:16px;margin:8px 0 0}.bilibili-statistics>div{min-width:25%}.bilibili-works>a{align-items:flex-start;gap:12px}.bilibili-watch{padding-top:3px;font-size:11px}.bilibili-heading{margin-bottom:18px}}
</style>
