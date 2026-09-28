<script setup lang="ts">
import { DOUYIN_PROFILE_URL, DouyinProfileSchema, type DouyinProfile, type DouyinWork } from '@xvyin/contracts'

const profile = ref<DouyinProfile | null>(null), pending = ref(true), avatarFailed = ref(false)
const api = useApi(), controller = new AbortController()
const statistics = computed(() => [
  { label: '粉丝', value: profile.value?.followers },
  { label: '关注', value: profile.value?.following },
  { label: '作品', value: profile.value?.postCount },
  { label: '获赞', value: profile.value?.likes },
])
const works = computed(() => profile.value?.works || [])
// This existing site selection remains available when the public collection cannot be read.
const collectedWork: DouyinWork = { id: '7661639577056136457', title: '学习摄影必会技能之一：星空摄影，星轨，银河', kind: 'video', url: 'https://www.douyin.com/video/7661639577056136457', publishedAt: null }
const displayedWorks = computed(() => works.value.length ? works.value : [collectedWork])
const selectedId = ref<string | null>(null), viewerHeading = ref<HTMLElement>()
const viewerId = useId()
const selectedVideo = computed(() => displayedWorks.value.find(work => work.id === selectedId.value && work.kind === 'video'))
const videoBlock = computed(() => selectedVideo.value ? { id: `douyin-${selectedVideo.value.id}`, type: 'video' as const, providerRef: { provider: 'douyin' as const, contentId: selectedVideo.value.id } } : undefined)
let lastTrigger: HTMLButtonElement | null = null

function dateLabel(value?: string | null, withTime = false) {
  return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } as const : {}) }).format(new Date(value)) : ''
}
async function selectVideo(work: DouyinWork, event: MouseEvent) {
  lastTrigger = event.currentTarget as HTMLButtonElement
  selectedId.value = work.id
  await nextTick()
  viewerHeading.value?.focus()
}
async function closeVideo() {
  selectedId.value = null
  await nextTick()
  if (lastTrigger?.isConnected) lastTrigger.focus()
}
onMounted(async () => {
  try {
    const result = DouyinProfileSchema.parse((await api<unknown>('/douyin/profile', { signal: controller.signal })).data)
    if (!controller.signal.aborted) profile.value = result
  } catch { if (!controller.signal.aborted) profile.value = null }
  finally { if (!controller.signal.aborted) pending.value = false }
})
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <section class="douyin-profile" aria-label="我的抖音" :aria-busy="pending">
    <div class="douyin-heading"><p class="douyin-eyebrow">抖音 · 摄影与日常</p><a :href="DOUYIN_PROFILE_URL" target="_blank" rel="noopener noreferrer" class="text-link">抖音主页 <SiteIcon name="external" :size="16" /></a></div>
    <div class="douyin-overview">
      <img v-if="profile?.avatarUrl && !avatarFailed" :src="profile.avatarUrl" alt="抖音头像" width="72" height="72" referrerpolicy="no-referrer" loading="lazy" @error="avatarFailed = true">
      <span v-else class="douyin-avatar" aria-hidden="true">光</span>
      <div class="douyin-identity"><h2>{{ profile?.name || '我在抖音' }}</h2><p class="douyin-handle">抖音号 tidingjinluo</p><p v-if="profile?.signature" class="douyin-signature">{{ profile.signature }}</p></div>
      <dl class="douyin-statistics"><div v-for="stat in statistics" :key="stat.label"><dt>{{ stat.label }}</dt><dd>{{ stat.value == null ? '—' : stat.value.toLocaleString('zh-CN') }}</dd></div></dl>
    </div>
    <p class="douyin-status" role="status"><template v-if="pending">正在读取抖音公开资料…</template><template v-else-if="profile?.status === 'fresh'">公开资料 · 更新于 {{ dateLabel(profile.updatedAt, true) }}（北京时间）</template><template v-else-if="profile?.status === 'stale'">暂时无法更新，显示 {{ dateLabel(profile.updatedAt, true) }}（北京时间）的公开资料。</template><template v-else-if="profile?.status === 'snapshot'">公开资料快照 · 截至 {{ dateLabel(profile.updatedAt, true) }}（北京时间）</template><template v-else>公开资料暂时无法读取，仍可查看本站收录的作品或前往抖音主页。</template></p>
    <div class="douyin-works">
      <div class="douyin-works-heading"><h3>{{ works.length ? '主页作品' : '本站收录' }}</h3><p v-if="works.length && profile?.worksUpdatedAt" class="douyin-status">更新于 {{ dateLabel(profile.worksUpdatedAt, true) }}（北京时间）</p></div>
      <p class="douyin-works-note">{{ works.length ? '按抖音主页顺序展示，可能包含置顶作品。视频可选看，图文请前往抖音阅读。' : '这部公开视频已由本站收录；更多作品请见抖音主页。' }}</p>
      <div class="douyin-work-list"><article v-for="work in displayedWorks" :key="work.id" class="douyin-work" :class="{ 'is-selected': selectedId === work.id }">
        <p class="douyin-work-meta"><span>{{ work.kind === 'video' ? '视频' : '图文' }}</span><time v-if="work.publishedAt" :datetime="work.publishedAt">{{ dateLabel(work.publishedAt) }}</time></p>
        <h4>{{ work.title }}</h4>
        <div class="douyin-work-actions"><button v-if="work.kind === 'video'" type="button" class="text-link" :aria-expanded="selectedId === work.id" :aria-controls="viewerId" :aria-label="`选看视频：${work.title}`" @click="selectVideo(work, $event)">{{ selectedId === work.id ? '已选中 · 查看播放器' : '选看视频' }}<SiteIcon name="play" :size="16" /></button><a :href="work.url" target="_blank" rel="noopener noreferrer" class="text-link">{{ work.kind === 'note' ? '在抖音阅读图文' : '原作品' }} <SiteIcon name="external" :size="14" /></a></div>
      </article></div>
      <div v-if="selectedVideo && videoBlock" :id="viewerId" class="douyin-viewer" role="region" :aria-label="`选看：${selectedVideo.title}`">
        <div class="douyin-viewer-heading"><h4 ref="viewerHeading" tabindex="-1">{{ selectedVideo.title }}</h4><button type="button" class="text-link" @click="closeVideo">关闭观看区域</button></div>
        <ContentMedia :key="selectedVideo.id" :block="videoBlock" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.douyin-profile{min-width:0;margin:0 0 clamp(36px,5vw,64px);padding:clamp(22px,3vw,32px) 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.douyin-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}.douyin-heading .text-link{font-size:13px;white-space:nowrap}.douyin-eyebrow{font-size:12px;letter-spacing:.12em;color:var(--muted);margin:0}.douyin-overview{display:flex;align-items:center;gap:20px}.douyin-overview>img,.douyin-avatar{flex:0 0 72px;width:72px;height:72px;object-fit:cover;border-radius:50%}.douyin-avatar{display:grid;place-items:center;font:38px/1 var(--serif);color:var(--green);background:var(--panel)}.douyin-identity{min-width:0;flex:1}.douyin-identity h2{font-size:clamp(23px,3vw,30px);font-weight:400;margin:0;line-height:1.4}.douyin-handle{font-size:11px;letter-spacing:.06em;color:var(--muted);margin:4px 0 0}.douyin-signature{font-size:13px;line-height:1.7;overflow-wrap:anywhere;white-space:pre-line;margin:8px 0 0}.douyin-statistics{display:flex;gap:clamp(20px,3vw,36px);margin:0 0 0 20px}.douyin-statistics>div{display:flex;flex-direction:column-reverse;gap:7px}.douyin-statistics dt{font-size:12px;color:var(--muted)}.douyin-statistics dd{font:clamp(22px,3vw,29px)/1.3 Georgia,serif;font-variant-numeric:tabular-nums;color:var(--green);margin:0;min-width:2ch}.douyin-status{font-size:11px;color:var(--muted);line-height:1.8;margin:20px 0 0}.douyin-works{border-top:1px solid var(--line);margin-top:24px;padding-top:22px}.douyin-works-heading{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}.douyin-works-heading h3{font-size:16px;font-weight:400;margin:0}.douyin-works-heading .douyin-status{margin:0}.douyin-works-note{font-size:12px;line-height:1.8;color:var(--muted);margin:10px 0 0}.douyin-work-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 28px;margin-top:22px}.douyin-work{min-width:0;padding:18px 0;border-bottom:1px solid var(--line)}.douyin-work.is-selected{border-bottom-color:var(--green)}.douyin-work-meta{display:flex;flex-wrap:wrap;gap:8px 14px;font-size:11px;color:var(--muted);margin:0 0 10px}.douyin-work h4{font-size:17px;line-height:1.7;font-weight:400;overflow-wrap:anywhere;margin:0 0 12px}.douyin-work-actions{display:flex;align-items:center;gap:8px 18px;flex-wrap:wrap}.douyin-work-actions .text-link,.douyin-viewer-heading .text-link{font-size:12px;min-height:44px}.douyin-work-actions button,.douyin-viewer-heading button{padding:0;background:transparent;border:0;font-family:inherit;color:var(--green);cursor:pointer}.douyin-works :is(button,a):focus-visible,.douyin-viewer-heading h4:focus{outline:2px solid var(--green);outline-offset:5px}.douyin-viewer{max-width:800px;min-width:0;margin-top:28px;scroll-margin-top:24px}.douyin-viewer-heading{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-bottom:16px}.douyin-viewer-heading h4{font-size:clamp(18px,2.2vw,23px);font-weight:400;line-height:1.6;margin:0;overflow-wrap:anywhere}.douyin-viewer-heading button{flex-shrink:0}
@media(max-width:900px){.douyin-overview{flex-wrap:wrap;gap:16px}.douyin-statistics{flex-basis:100%;justify-content:space-between;gap:16px;margin:8px 0 0}.douyin-work-list{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.douyin-overview>img,.douyin-avatar{flex-basis:60px;width:60px;height:60px}.douyin-statistics{gap:12px;flex-wrap:wrap}.douyin-statistics>div{flex:1;min-width:54px}.douyin-heading{margin-bottom:18px}.douyin-work-list{grid-template-columns:1fr}.douyin-viewer-heading{align-items:flex-start;flex-wrap:wrap;gap:8px}.douyin-work h4{font-size:16px}}
</style>
