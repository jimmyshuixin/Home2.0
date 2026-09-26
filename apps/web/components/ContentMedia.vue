<script setup lang="ts">
import { assetVariant, providerLink, type Block } from '~/lib/site'
import { providerEmbed } from '~/lib/provider-embed'
import type { MediaFocusTarget } from '~/lib/media-focus'

const props = defineProps<{ block: Extract<Block, { type: 'audio' | 'video' }> }>()
const nuxt = useNuxtApp()
const source = computed(() => assetVariant(props.block.assetId, 'playback'))
const title = computed(() => props.block.type === 'audio' ? props.block.title : '正文视频')
const artist = computed(() => props.block.type === 'audio' ? props.block.artist : '')
const poster = computed(() => assetVariant(props.block.type === 'video' ? props.block.posterAssetId : props.block.coverAssetId, 'poster'))
const captions = computed(() => assetVariant(props.block.type === 'video' ? props.block.captionsAssetId : undefined, 'captions'))
const external = computed(() => props.block.type === 'video' && !source.value ? providerEmbed(props.block.providerRef) : undefined)
const originalLink = computed(() => providerLink(props.block.providerRef))
const failed = ref(false), loading = ref(false), element = ref<HTMLMediaElement>()
const embedOpen = ref(false), embedAttempt = ref(0)
const embedStatus = ref<'idle' | 'requesting' | 'available' | 'slow' | 'error' | 'stopped'>('idle')
let embedTimer: ReturnType<typeof setTimeout> | undefined
const embedFocus: MediaFocusTarget = { pause: () => closeEmbed('stopped') }
const ratio = computed(() => {
  if (props.block.type !== 'video') return undefined
  if (external.value) return props.block.aspectRatio || 16 / 9
  const variant = source.value
  return variant?.width && variant?.height ? variant.width / variant.height : props.block.aspectRatio || (poster.value?.width && poster.value?.height ? poster.value.width / poster.value.height : 16 / 9)
})
function retry() { failed.value = false; loading.value = false; element.value?.load() }
function started() { const media = element.value; if (media) nuxt.$mediaFocus?.activate(media) }
function clearEmbedTimer() { if (embedTimer !== undefined) { clearTimeout(embedTimer); embedTimer = undefined } }
function closeEmbed(status: typeof embedStatus.value = 'idle') {
  clearEmbedTimer(); embedOpen.value = false; embedStatus.value = status
  nuxt.$mediaFocus?.release(embedFocus)
}
function openEmbed() {
  if (!external.value) return
  clearEmbedTimer()
  // Reserve focus on the explicit click, including cancellation of pending site music.
  nuxt.$mediaFocus?.activate(embedFocus)
  embedAttempt.value++; embedStatus.value = 'requesting'; embedOpen.value = true
  embedTimer = setTimeout(() => { if (embedStatus.value === 'requesting') embedStatus.value = 'slow' }, 12000)
}
function embedLoaded() {
  if (!embedOpen.value) return
  clearEmbedTimer()
  // An iframe load event cannot tell us whether a cross-origin video is playable.
  embedStatus.value = 'available'
}
watch(() => external.value?.src, () => closeEmbed())
onBeforeUnmount(() => {
  closeEmbed()
  if (element.value) { element.value.pause(); nuxt.$mediaFocus?.release(element.value) }
})
</script>

<template>
  <section :class="['content-media', block.type === 'audio' ? 'audio-block' : 'video-block', { 'portrait-video': ratio && ratio < 1 }]" :style="ratio ? { '--video-ratio': ratio } : undefined" :aria-label="title">
    <img v-if="block.type === 'audio' && poster" class="content-audio-cover" :src="poster.url" :width="poster.width" :height="poster.height" alt="" loading="lazy">
    <h3 v-if="block.type === 'audio'">{{ title }}</h3>
    <p v-if="artist" class="small muted">{{ artist }}</p>
    <template v-if="source">
      <audio v-if="block.type === 'audio'" ref="element" :src="source.url" controls preload="none" @play="started" @waiting="loading = true" @playing="loading = false" @canplay="loading = false" @error="failed = true; loading = false" />
      <video v-else ref="element" :src="source.url" :poster="poster?.url" controls playsinline preload="none" :width="source.width" :height="source.height" @play="started" @waiting="loading = true" @playing="loading = false" @canplay="loading = false" @error="failed = true; loading = false">
        <track v-if="captions" kind="captions" label="中文字幕" srclang="zh" :src="captions.url" default>
      </video>
      <p v-if="loading" class="small muted" role="status">正在缓冲…</p>
      <div v-if="failed" class="feedback error" role="status">媒体暂时无法播放，文字仍可继续阅读。<button @click="retry">重新加载</button></div>
    </template>
    <div v-else-if="external" class="external-video">
      <div class="external-stage" :class="{ 'has-player': embedOpen }">
        <iframe v-if="embedOpen" :key="embedAttempt" :src="external.src" :title="`${external.label} 官方视频播放器`" allow="fullscreen; picture-in-picture; encrypted-media" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" @load="embedLoaded" @error="closeEmbed('error')" />
        <template v-else>
          <img v-if="poster" class="external-cover" :src="poster.url" :width="poster.width" :height="poster.height" alt="" loading="lazy">
          <div class="external-invitation">
            <span class="external-platform">{{ external.label }} · 视频</span>
            <button type="button" class="external-open" @click="openEmbed"><SiteIcon name="play" />{{ embedStatus === 'error' ? '重试站内观看' : '站内观看' }}</button>
            <span class="small">点击后加载 {{ external.label }} 官方播放器</span>
          </div>
        </template>
      </div>
      <div class="external-footer">
        <div class="external-status small muted" role="status" aria-live="polite">
          <p v-if="embedStatus === 'requesting'">正在请求 {{ external.label }} 播放器…</p>
          <p v-else-if="embedStatus === 'slow'">播放器加载较久，可以继续等待、重新加载或前往原平台。</p>
          <p v-else-if="embedStatus === 'error'">播放器未能完成加载，请重试或前往原平台。</p>
          <p v-else-if="embedStatus === 'stopped'">已关闭此播放器，避免与其他媒体同时播放。</p>
          <p v-else-if="embedOpen">请在播放器内点击播放；如无法观看，可重新加载或前往原平台。</p>
          <p v-else>按需加载，不自动播放。播放、清晰度及登录要求由原平台提供。</p>
        </div>
        <div class="external-actions">
          <template v-if="embedOpen"><button type="button" class="text-link" @click="openEmbed">重新加载</button><button type="button" class="text-link" @click="closeEmbed()">关闭播放器</button></template>
          <a :href="originalLink" target="_blank" rel="noopener noreferrer" class="text-link">前往 {{ external.label }} <SiteIcon name="external" /></a>
        </div>
      </div>
    </div>
    <div v-else class="media-unavailable">
      <img v-if="poster && block.providerRef" :src="poster.url" alt="" loading="lazy" class="external-poster">
      <p>{{ block.providerRef ? (block.type === 'video' ? '这段视频发布在站外平台。' : '这段音频发布在站外平台。') : '媒体暂时不可用，文字仍可继续阅读。' }}</p>
      <a v-if="originalLink" :href="originalLink" target="_blank" rel="noopener noreferrer" class="text-link">前往原平台 <SiteIcon name="external" /></a>
    </div>
    <details v-if="block.transcript" class="disclosure"><summary>{{ block.type === 'audio' ? '阅读文字稿' : '文字说明与字幕' }}</summary><p class="transcript">{{ block.transcript }}</p></details>
  </section>
</template>

<style scoped>
.external-poster{max-width:100%;max-height:360px;object-fit:contain;display:block;margin-bottom:18px}.content-media{min-width:0;width:100%;margin:0;overflow-wrap:anywhere}.content-media.audio-block{background:transparent;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:clamp(20px,3vw,30px) 0;display:flow-root}.content-media h3{font-size:clamp(20px,2.5vw,25px);font-weight:400;line-height:1.5;margin:0 0 6px}.content-media audio{min-width:0;width:100%;margin:20px 0 0;height:44px}.content-audio-cover{width:76px;height:76px;object-fit:contain;float:right;margin:0 0 16px 24px}.content-media .disclosure{clear:both;margin-top:20px;border-bottom:0}.content-media video{width:100%;height:auto;aspect-ratio:var(--video-ratio,16/9);max-height:min(78svh,760px);object-fit:contain;background:#17211d}.portrait-video{max-width:440px;margin-inline:auto}.content-media .transcript{line-height:1.9}.content-media .media-unavailable{background:var(--panel);border:0;padding:clamp(24px,4vw,40px)}.content-media .feedback{margin-top:16px}
.external-video{border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.external-stage{position:relative;display:grid;place-items:center;min-height:200px;aspect-ratio:var(--video-ratio,16/9);overflow:hidden;background:var(--panel);isolation:isolate}.external-stage.has-player{background:#17211d}.external-stage iframe{position:absolute;inset:0;display:block;width:100%;height:100%;border:0}.external-cover{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-2;opacity:.18}.external-invitation{display:flex;flex-direction:column;align-items:center;gap:clamp(10px,2vw,20px);padding:20px;text-align:center}.external-platform{font-size:12px;letter-spacing:.14em}.external-open{display:inline-flex;align-items:center;justify-content:center;gap:12px;min-height:48px;padding:12px 26px;border:1px solid currentColor;background:var(--panel);color:inherit;font:inherit;cursor:pointer}.external-open:hover{background:var(--paper)}.external-open:focus-visible,.external-actions :focus-visible{outline:2px solid currentColor;outline-offset:5px}.external-open :deep(svg){width:18px;height:18px}.external-footer{padding:18px 0}.external-status p{margin:0;line-height:1.7}.external-actions{display:flex;flex-wrap:wrap;gap:12px 22px;align-items:center;margin-top:12px}.external-actions button{font:inherit;color:inherit;padding:0;cursor:pointer;background:transparent;border:0}.external-actions .text-link{min-height:44px}
@media(max-width:600px){.content-audio-cover{width:60px;height:60px;margin-left:16px}.content-media audio{height:44px}.portrait-video{max-width:100%}.external-invitation{gap:10px;padding:16px}.external-invitation .small{font-size:12px}.external-open{min-height:44px;padding:9px 20px}.external-actions{gap:10px 18px}}
</style>
