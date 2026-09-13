<script setup lang="ts">
import { assetVariant, providerLink, type Block } from '~/lib/site'
const props = defineProps<{ block: Extract<Block, { type: 'audio' | 'video' }> }>()
const source = computed(() => assetVariant(props.block.assetId, 'playback'))
const title = computed(() => props.block.type === 'audio' ? props.block.title : '正文视频')
const artist = computed(() => props.block.type === 'audio' ? props.block.artist : '')
const poster = computed(() => assetVariant(props.block.type === 'video' ? props.block.posterAssetId : props.block.coverAssetId, 'poster'))
const captions = computed(() => assetVariant(props.block.type === 'video' ? props.block.captionsAssetId : undefined, 'captions'))
const failed = ref(false), loading = ref(false), element = ref<HTMLMediaElement>()
const ratio = computed(() => {
  if (props.block.type !== 'video') return undefined
  const variant = source.value
  return variant?.width && variant?.height ? variant.width / variant.height : props.block.aspectRatio || (poster.value?.width && poster.value?.height ? poster.value.width / poster.value.height : 16 / 9)
})
function retry() { failed.value = false; loading.value = false; element.value?.load() }
function started() { const media = element.value; if (media) useNuxtApp().$mediaFocus?.activate(media) }
onBeforeUnmount(() => { if (element.value) { element.value.pause(); useNuxtApp().$mediaFocus?.release(element.value) } })
</script>

<style scoped>
.content-media{min-width:0;width:100%;margin:0;overflow-wrap:anywhere}.content-media.audio-block{background:transparent;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:clamp(20px,3vw,30px) 0;display:flow-root}.content-media h3{font-size:clamp(20px,2.5vw,25px);font-weight:400;line-height:1.5;margin:0 0 6px}.content-media audio{min-width:0;width:100%;margin:20px 0 0;height:44px}.content-audio-cover{width:76px;height:76px;object-fit:contain;float:right;margin:0 0 16px 24px}.content-media .disclosure{clear:both;margin-top:20px;border-bottom:0}.content-media video{width:100%;height:auto;aspect-ratio:var(--video-ratio,16/9);max-height:min(78svh,760px);object-fit:contain;background:#17211d}.portrait-video{max-width:440px;margin-inline:auto}.content-media .transcript{line-height:1.9}.content-media .media-unavailable{background:var(--panel);border:0;padding:clamp(24px,4vw,40px)}.content-media .feedback{margin-top:16px}
@media(max-width:600px){.content-audio-cover{width:60px;height:60px;margin-left:16px}.content-media audio{height:44px}.portrait-video{max-width:100%}}
</style>
<template><section :class="['content-media', block.type === 'audio' ? 'audio-block' : 'video-block', { 'portrait-video': ratio && ratio < 1 }]" :style="ratio ? { '--video-ratio': ratio } : undefined" :aria-label="title"><img v-if="block.type === 'audio' && poster" class="content-audio-cover" :src="poster.url" :width="poster.width" :height="poster.height" alt="" loading="lazy"><h3 v-if="block.type === 'audio'">{{ title }}</h3><p v-if="artist" class="small muted">{{ artist }}</p><template v-if="source"><audio v-if="block.type === 'audio'" ref="element" :src="source.url" controls preload="none" @play="started" @waiting="loading = true" @playing="loading = false" @canplay="loading = false" @error="failed = true; loading = false" /><video v-else ref="element" :src="source.url" :poster="poster?.url" controls playsinline preload="none" :width="source.width" :height="source.height" @play="started" @waiting="loading = true" @playing="loading = false" @canplay="loading = false" @error="failed = true; loading = false"><track v-if="captions" kind="captions" label="中文字幕" srclang="zh" :src="captions.url" default></video><p v-if="loading" class="small muted" role="status">正在缓冲…</p><div v-if="failed" class="feedback error" role="status">媒体暂时无法播放，文字仍可继续阅读。<button @click="retry">重新加载</button></div></template><div v-else class="media-unavailable"><p>媒体暂时不可用，文字仍可继续阅读。</p><a v-if="providerLink(block.providerRef)" :href="providerLink(block.providerRef)" target="_blank" rel="noopener noreferrer" class="text-link">前往原平台 <SiteIcon name="external" /></a></div><details v-if="block.transcript" class="disclosure"><summary>{{ block.type === 'audio' ? '阅读文字稿' : '文字说明与字幕' }}</summary><p class="transcript">{{ block.transcript }}</p></details></section></template>
