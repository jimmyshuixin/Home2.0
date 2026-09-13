<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { errorMessage, type MediaItem } from '../api';
import { adminMediaFocus, previewSource, privateMediaUrl, readMedia } from '../media';

const props = defineProps<{ assetId?: string | null; item?: MediaItem; label?: string; compact?: boolean; posterAssetId?: string | null; captionsAssetId?: string | null }>();
const asset = ref<MediaItem>();
const selectedPoster = ref<MediaItem>(), selectedCaptions = ref<MediaItem>(), auxiliaryIssue = ref('');
const loading = ref(false), issue = ref(''), failed = ref(false), imageReady = ref(false), lightboxOpen = ref(false);
const player = ref<HTMLMediaElement>(), dialog = ref<HTMLDialogElement>();
let sequence = 0, auxiliarySequence = 0;
const name = computed(() => props.label || asset.value?.originalName || '媒体预览');
const source = computed(() => asset.value && previewSource(asset.value, props.compact));
const videoVariant = computed(() => asset.value?.variants.find(variant => variant.role === 'playback'));
const videoRatio = computed(() => videoVariant.value?.width && videoVariant.value?.height ? videoVariant.value.width / videoVariant.value.height : undefined);
const fullImage = computed(() => asset.value && privateMediaUrl(asset.value, ['content', 'poster', 'thumb']));
const poster = computed(() => selectedPoster.value ? privateMediaUrl(selectedPoster.value, ['poster', 'content', 'thumb']) : asset.value && privateMediaUrl(asset.value, ['poster', 'thumb']));
const captions = computed(() => selectedCaptions.value && privateMediaUrl(selectedCaptions.value, ['captions', 'download']));
const status = computed(() => asset.value?.processingStatus ?? asset.value?.status);
function stop() { if (player.value) { player.value.pause(); adminMediaFocus.release(player.value); } }
async function load() {
  const current = ++sequence;
  stop(); issue.value = ''; failed.value = false; imageReady.value = false; asset.value = undefined;
  if (props.item) { asset.value = props.item; loading.value = false; return; }
  if (!props.assetId) { loading.value = false; return; }
  loading.value = true;
  try { const result = await readMedia(props.assetId); if (current === sequence) asset.value = result; }
  catch (error) { if (current === sequence) issue.value = errorMessage(error); }
  finally { if (current === sequence) loading.value = false; }
}
function started() { if (player.value) adminMediaFocus.activate(player.value); }
async function enlarge() { lightboxOpen.value = true; await nextTick(); dialog.value?.showModal(); }
async function retry() { await load(); await nextTick(); player.value?.load(); }
watch(() => [props.assetId, props.item] as const, load, { immediate: true });
async function loadAuxiliary() {
  const current = ++auxiliarySequence; selectedPoster.value = undefined; selectedCaptions.value = undefined; auxiliaryIssue.value = '';
  const results = await Promise.allSettled([props.posterAssetId ? readMedia(props.posterAssetId) : undefined, props.captionsAssetId ? readMedia(props.captionsAssetId) : undefined]);
  if (current !== auxiliarySequence) return;
  if (results[0].status === 'fulfilled') selectedPoster.value = results[0].value;
  if (results[1].status === 'fulfilled') selectedCaptions.value = results[1].value;
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (errors.length) auxiliaryIssue.value = `封面或字幕暂未加载：${errorMessage(errors[0]?.reason)}`;
}
watch(() => [props.posterAssetId, props.captionsAssetId] as const, loadAuxiliary, { immediate: true });
onBeforeUnmount(() => { sequence++; auxiliarySequence++; stop(); dialog.value?.close(); });
</script>

<template>
  <div class="asset-preview" :class="{ compact }" :aria-label="name">
    <p v-if="loading" class="preview-placeholder" role="status">正在读取媒体…</p>
    <div v-else-if="issue" class="preview-placeholder" role="status"><p>{{ issue }}</p><button type="button" @click="load">重新读取</button></div>
    <p v-else-if="!asset" class="preview-placeholder">选择媒体后在这里预览</p>
    <div v-else-if="status !== 'ready'" class="preview-placeholder" role="status"><p>{{ status === 'failed' ? '媒体处理失败' : '媒体正在处理，完成后可预览' }}</p><p v-if="asset.error" class="hint">{{ asset.error.message }}</p><button v-if="!item" type="button" @click="load">刷新状态</button></div>
    <template v-else-if="source">
      <button v-if="asset.kind === 'image'" type="button" class="image-preview" :aria-label="`放大查看：${name}`" @click="enlarge">
        <img :key="source" :src="source" :alt="name" loading="lazy" @load="imageReady = true" @error="failed = true">
        <span v-if="imageReady && !failed" class="image-enlarge">放大查看 ↗</span>
      </button>
      <template v-else-if="asset.kind === 'audio'"><img v-if="poster" class="audio-cover" :src="poster" :alt="`${name}封面`"><audio :key="source" ref="player" :src="source" controls preload="none" :aria-label="`试听：${name}`" @play="started" @error="failed = true" /></template>
      <video :style="videoRatio ? { aspectRatio: videoRatio } : undefined" v-else-if="asset.kind === 'video'" :key="source" ref="player" :src="source" :poster="poster" controls playsinline preload="none" :aria-label="`视频预览：${name}`" @play="started" @error="failed = true"><track v-if="captions" kind="captions" label="中文字幕" srclang="zh" :src="captions" default></video>
      <a v-else class="button" :href="source" target="_blank" rel="noopener noreferrer">打开附件 ↗</a>
      <div v-if="failed" class="preview-error" role="status"><p>暂时无法加载{{ asset.kind === 'image' ? '图片' : '媒体' }}，请重试。</p><button type="button" @click="retry">重新加载</button></div>
    </template>
    <p v-else class="preview-placeholder">尚无可预览版本，请在媒体库检查处理状态。</p><p v-if="auxiliaryIssue" class="hint" role="status">{{ auxiliaryIssue }} <button type="button" @click="loadAuxiliary">重新加载封面与字幕</button></p>
    <dialog v-if="asset?.kind === 'image' && fullImage" ref="dialog" class="image-lightbox" :aria-label="`图片预览：${name}`" @close="lightboxOpen = false" @click="event => { if (event.target === dialog) dialog?.close(); }">
      <header><strong>{{ name }}</strong><button type="button" aria-label="关闭图片预览" @click="dialog?.close()">关闭</button></header>
      <img v-if="lightboxOpen" :src="fullImage" :alt="name">
    </dialog>
  </div>
</template>

<style scoped>
.audio-cover{display:block;width:100px;height:100px;object-fit:cover;margin-bottom:12px;border-radius:4px}
.asset-preview{min-width:0;width:100%;padding:14px;background:#eeefe7;border-radius:7px;overflow:hidden}.preview-placeholder{min-height:64px;display:grid;align-content:center;justify-items:start;gap:12px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}.image-preview{display:block;position:relative;width:100%;padding:0;border:0;background:transparent;overflow:hidden;border-radius:4px}.image-preview img{display:block;width:100%;height:auto;max-height:300px;object-fit:contain;background:transparent}.image-enlarge{position:absolute;bottom:8px;right:8px;background:#fffef4e8;color:var(--green);font-size:11px;padding:4px 9px;border-radius:4px}audio{display:block;width:100%;min-width:0;height:42px}video{display:block;width:100%;height:auto;max-height:min(70svh,560px);object-fit:contain;background:#1b2420;border-radius:4px}.compact{padding:10px}.compact .image-preview img{height:150px;object-fit:contain}.compact .preview-placeholder{min-height:112px}.compact audio{margin-block:46px 44px}.preview-error{color:var(--red);font-size:12px;margin-top:10px;display:grid;gap:8px}.image-lightbox{width:min(1100px,calc(100vw - 32px));max-height:92dvh;padding:16px}.image-lightbox header{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:16px;font-size:13px;overflow-wrap:anywhere}.image-lightbox img{display:block;width:100%;height:auto;max-height:75dvh;object-fit:contain;background:transparent}@media(max-width:600px){.compact .image-preview img{height:130px}.image-preview img{max-height:240px}.image-lightbox{padding:12px}}
</style>
