<script setup lang="ts">
import { assetVariant, providerLink, type Block } from '~/lib/site'
const props = defineProps<{ block: Extract<Block, { type: 'audio' | 'video' }> }>()
const source = computed(() => assetVariant(props.block.assetId, 'playback'))
const title = computed(() => props.block.type === 'audio' ? props.block.title : '正文视频')
const artist = computed(() => props.block.type === 'audio' ? props.block.artist : '')
const poster = computed(() => assetVariant(props.block.type === 'video' ? props.block.posterAssetId : props.block.coverAssetId, 'poster'))
const captions = computed(() => assetVariant(props.block.type === 'video' ? props.block.captionsAssetId : undefined, 'captions'))
const failed = ref(false), loading = ref(false), element = ref<HTMLMediaElement>()
function retry() { failed.value = false; loading.value = false; element.value?.load() }
function started() { const media = element.value; if (media) useNuxtApp().$mediaFocus?.activate(media) }
</script>
<template><section :class="block.type === 'audio' ? 'audio-block' : 'video-block'" :aria-label="title"><h3 v-if="block.type === 'audio'">{{ title }}</h3><p v-if="artist" class="small muted">{{ artist }}</p><template v-if="source"><audio v-if="block.type === 'audio'" ref="element" :src="source.url" controls preload="none" @play="started" @waiting="loading = true" @playing="loading = false" @canplay="loading = false" @error="failed = true; loading = false" /><video v-else ref="element" :src="source.url" :poster="poster?.url" controls playsinline preload="none" :width="source.width" :height="source.height" @play="started" @waiting="loading = true" @playing="loading = false" @canplay="loading = false" @error="failed = true; loading = false"><track v-if="captions" kind="captions" label="中文字幕" srclang="zh" :src="captions.url" default></video><p v-if="loading" class="small muted" role="status">正在缓冲…</p><div v-if="failed" class="feedback error" role="status">媒体暂时无法播放，文字仍可继续阅读。<button @click="retry">重新加载</button></div></template><div v-else class="media-unavailable"><p>媒体暂时不可用，文字仍可继续阅读。</p><a v-if="providerLink(block.providerRef)" :href="providerLink(block.providerRef)" target="_blank" rel="noopener noreferrer" class="text-link">前往原平台 <SiteIcon name="external" /></a></div><details v-if="block.transcript" class="disclosure"><summary>{{ block.type === 'audio' ? '阅读文字稿' : '文字说明与字幕' }}</summary><p class="transcript">{{ block.transcript }}</p></details></section></template>
