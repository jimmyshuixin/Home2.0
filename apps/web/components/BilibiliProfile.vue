<script setup lang="ts">
import { BILIBILI_PROFILE_URL, BILIBILI_UID, BilibiliProfileSchema, type BilibiliProfile } from '@xvyin/contracts'
import { site, ordered } from '~/lib/site'
import { providerEmbed } from '~/lib/provider-embed'

defineProps<{ showWorks?: boolean }>()
const profile = ref<BilibiliProfile | null>(null)
const pending = ref(true), avatarFailed = ref(false)
const api = useApi(), controller = new AbortController()
const profileUrl = BILIBILI_PROFILE_URL
const works = ordered(site.creations).filter(entry => entry.blocks.some(block => block.type === 'video' && block.providerRef?.provider === 'bilibili'))
const syncedWorks = computed(() => (profile.value?.works || []).filter(work => providerEmbed({ provider: 'bilibili', contentId: work.bvid })))
const selectedWork = ref<string | null>(null), failedCovers = ref<Record<string, boolean>>({})
const statistics = computed(() => [
  { label: '粉丝', value: profile.value?.followers },
  { label: '投稿', value: profile.value?.videoCount },
  { label: '获赞', value: profile.value?.likes },
])
const updated = computed(() => profile.value?.updatedAt ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(profile.value.updatedAt)) : '')
const worksUpdated = computed(() => profile.value?.worksUpdatedAt ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(profile.value.worksUpdatedAt)) : '')
function durationLabel(seconds: number | null) { return seconds == null ? '' : `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}` }
function publishedLabel(value: string | null) { return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : '' }
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
    <div v-if="showWorks && syncedWorks.length" class="bilibili-synced">
      <div class="bilibili-synced-heading"><p class="bilibili-eyebrow">B 站同步作品</p><p v-if="worksUpdated" class="bilibili-status">同步于 {{ worksUpdated }}（北京时间）</p></div>
      <article v-for="work in syncedWorks.slice(0, 6)" :key="work.bvid" class="bilibili-synced-work">
        <button type="button" class="bilibili-work-toggle" :aria-expanded="selectedWork === work.bvid" :aria-controls="`bilibili-video-${work.bvid}`" @click="selectedWork = selectedWork === work.bvid ? null : work.bvid">
          <img v-if="work.coverUrl && !failedCovers[work.bvid]" :src="work.coverUrl" alt="" width="160" height="100" loading="lazy" referrerpolicy="no-referrer" @error="failedCovers[work.bvid] = true">
          <span v-else class="bilibili-work-cover" aria-hidden="true"><SiteIcon name="play" /></span>
          <span class="bilibili-work-copy"><strong>{{ work.title }}</strong><span class="bilibili-work-meta"><span v-if="work.publishedAt">{{ publishedLabel(work.publishedAt) }}</span><span v-if="work.views !== null">{{ work.views.toLocaleString('zh-CN') }} 次播放</span><span v-if="work.durationSeconds !== null">{{ durationLabel(work.durationSeconds) }}</span></span></span>
          <span class="bilibili-watch">{{ selectedWork === work.bvid ? '收起' : '展开视频' }}<SiteIcon :name="selectedWork === work.bvid ? 'close' : 'play'" :size="16" /></span>
        </button>
        <div v-if="selectedWork === work.bvid" :id="`bilibili-video-${work.bvid}`" class="bilibili-work-player"><ContentMedia :block="{ id: `bili-${work.bvid}`, type: 'video', providerRef: { provider: 'bilibili', contentId: work.bvid } }" /></div>
      </article>
      <a :href="profileUrl" target="_blank" rel="noopener noreferrer" class="text-link bilibili-more">在 B 站查看全部作品 <SiteIcon name="external" :size="16" /></a>
    </div>
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
.bilibili-synced{border-top:1px solid var(--line);margin-top:24px;padding-top:22px}.bilibili-synced-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px}.bilibili-synced-heading .bilibili-status{margin:0}.bilibili-synced-work+.bilibili-synced-work{border-top:1px solid var(--line)}.bilibili-work-toggle{display:grid;grid-template-columns:128px minmax(0,1fr) auto;width:100%;gap:20px;align-items:center;text-align:left;padding:18px 0;border:0;border-radius:0;background:transparent;color:inherit;font:inherit;cursor:pointer}.bilibili-work-toggle:hover{background:transparent}.bilibili-work-toggle:hover strong{text-decoration:underline;text-underline-offset:5px}.bilibili-work-toggle>img,.bilibili-work-cover{display:block;width:128px;height:80px;object-fit:cover;background:var(--panel)}.bilibili-work-cover{display:grid;place-items:center;color:var(--green)}.bilibili-work-copy{min-width:0}.bilibili-work-copy>strong{display:block;font-size:16px;font-weight:400;line-height:1.6;overflow-wrap:anywhere}.bilibili-work-meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--muted);margin-top:7px;line-height:1.5}.bilibili-work-player{padding-bottom:20px}.bilibili-more{font-size:12px;margin-top:12px}
@media(max-width:760px){.bilibili-overview{flex-wrap:wrap;gap:16px}.bilibili-overview>img,.bilibili-avatar{flex-basis:60px;width:60px;height:60px}.bilibili-statistics{flex-basis:100%;justify-content:space-between;gap:16px;margin:8px 0 0}.bilibili-statistics>div{min-width:25%}.bilibili-works>a{align-items:flex-start;gap:12px}.bilibili-watch{padding-top:3px;font-size:11px}.bilibili-heading{margin-bottom:18px}}
@media(max-width:600px){.bilibili-work-toggle{grid-template-columns:88px minmax(0,1fr);gap:10px 14px}.bilibili-work-toggle>img,.bilibili-work-cover{width:88px;height:64px;grid-row:1/3;align-self:start}.bilibili-work-toggle>.bilibili-watch{grid-column:2}.bilibili-work-copy>strong{font-size:14px}.bilibili-work-meta{font-size:10px;gap:4px 10px}.bilibili-synced-heading{align-items:flex-start;flex-direction:column}}
</style>
