<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import type { AlbumDraft, CreationDraft, FitnessEntryDraft, PlaylistDraft } from '@xvyin/contracts';
import type { Collection } from '../api';
import { externalMediaLink } from '../media';
import MediaPreview from './MediaPreview.vue';
import DraftRichText from './DraftRichText';
const props = defineProps<{ collection: Collection; draft: CreationDraft | AlbumDraft | FitnessEntryDraft | PlaylistDraft }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const creation = computed(() => props.draft as CreationDraft);
const photoDraft = computed(() => props.draft as AlbumDraft | FitnessEntryDraft);
const playlist = computed(() => props.draft as PlaylistDraft);
const title = computed(() => 'name' in props.draft ? props.draft.name : props.draft.title);
onMounted(() => dialog.value?.showModal());
onBeforeUnmount(() => dialog.value?.close());
</script>
<template>
  <dialog ref="dialog" class="draft-preview-dialog" aria-labelledby="draft-preview-heading" @cancel.prevent="emit('close')" @close="emit('close')">
    <header class="dialog-head"><div><p class="eyebrow">DRAFT PREVIEW</p><h2 id="draft-preview-heading">预览当前编辑</h2></div><button type="button" @click="emit('close')">返回编辑</button></header>
    <div class="dialog-content">
      <p class="draft-note">包含当前尚未保存的编辑，仅供你查看。保存草稿后可到发布中心生成网站完整预览。</p>
      <article class="draft-paper"><h1>{{ title || '未命名内容' }}</h1>
        <template v-if="collection === 'creations'">
          <p v-if="creation.summary" class="summary">{{ creation.summary }}</p>
          <MediaPreview v-if="creation.coverAssetId" :asset-id="creation.coverAssetId" label="创作封面"/>
          <p v-if="!creation.blocks.length" class="hint">尚未添加正文内容。</p>
          <section v-for="block in creation.blocks" :key="block.id" class="draft-block">
            <DraftRichText v-if="block.type === 'richtext'" :document="block.document"/>
            <figure v-else-if="block.type === 'image'"><MediaPreview :asset-id="block.assetId" :label="block.alt || '正文图片'"/><figcaption v-if="block.caption">{{ block.caption }}</figcaption></figure>
            <div v-else-if="block.type === 'gallery'" class="draft-gallery" :class="{ stack: block.layout === 'stack' }"><figure v-for="(photo, index) in block.items" :key="`${photo.assetId}/${index}`"><MediaPreview :asset-id="photo.assetId" :label="photo.alt || '图集图片'"/><figcaption v-if="photo.caption">{{ photo.caption }}</figcaption></figure></div>
            <template v-else-if="block.type === 'audio' || block.type === 'video'">
              <h3 v-if="block.type === 'audio'">{{ block.title || '正文音频' }}</h3><p v-if="block.type === 'audio' && block.artist" class="hint">{{ block.artist }}</p>
              <MediaPreview v-if="block.assetId" :asset-id="block.assetId" :label="block.type === 'audio' ? block.title : '正文视频'" :poster-asset-id="block.type === 'video' ? block.posterAssetId : block.coverAssetId" :captions-asset-id="block.type === 'video' ? block.captionsAssetId : undefined"/>
              <div v-else class="external-preview"><MediaPreview v-if="block.type === 'video' && block.posterAssetId" :asset-id="block.posterAssetId" label="视频封面"/><p>外部平台内容</p><a v-if="externalMediaLink(block.providerRef)" :href="externalMediaLink(block.providerRef)" target="_blank" rel="noopener noreferrer">到原平台查看{{ block.type === 'audio' ? '音频' : '视频' }} ↗</a><span v-else>填写平台与内容 ID 后可查看。</span></div>
              <p v-if="block.transcript" class="transcript">{{ block.transcript }}</p>
            </template>
            <blockquote v-else-if="block.type === 'quote'"><p>{{ block.text }}</p><cite>{{ block.attribution }}</cite></blockquote>
            <div v-else-if="block.type === 'code'"><p class="hint">{{ block.filename || block.language }}</p><pre><code>{{ block.code }}</code></pre></div>
            <template v-else-if="block.type === 'file'"><h3>{{ block.label || '附件' }}</h3><p>{{ block.description }}</p><MediaPreview :asset-id="block.assetId" :label="block.label"/></template>
          </section>
        </template>
        <template v-else-if="collection === 'albums' || collection === 'fitness'">
          <p class="summary">{{ 'description' in photoDraft ? photoDraft.description : photoDraft.caption }}</p>
          <figure v-for="photo in photoDraft.photos" :key="photo.id" class="draft-block"><span class="badge">{{ { draft: '照片暂留草稿', hidden: '照片已隐藏', published: '随记录发布' }[photo.status] }}</span><MediaPreview :asset-id="photo.assetId" :label="photo.alt || '照片'"/><figcaption>{{ photo.caption }}<small v-if="photo.photoDate"> · {{ photo.photoDate }}</small></figcaption></figure>
          <p v-if="!photoDraft.photos.length" class="hint">尚未添加照片。</p>
        </template>
        <template v-else><p class="hint">{{ playlist.tracks.length }} 首曲目</p><section v-for="track in playlist.tracks" :key="track.id" class="draft-block"><h3>{{ track.title || '未命名曲目' }}</h3><p>{{ track.artist }}</p><MediaPreview v-if="track.assetId" :asset-id="track.assetId" :label="track.title"/><a v-else-if="externalMediaLink(track.providerRef)" :href="externalMediaLink(track.providerRef)" target="_blank" rel="noopener noreferrer">到原平台试听 ↗</a></section><p v-if="playlist.source !== 'local'" class="hint">这里预览已填写曲目；平台歌单内容由网站播放时读取。</p></template>
      </article>
    </div>
  </dialog>
</template>
<style scoped>
.draft-preview-dialog{width:min(960px,calc(100vw - 24px))}.draft-note{font-size:12px;line-height:1.8;color:var(--muted);padding-bottom:24px;border-bottom:1px solid var(--line)}.draft-paper{max-width:740px;margin:30px auto;overflow-wrap:anywhere}.draft-paper h1{font-size:34px;font-family:Georgia,'STKaiti','KaiTi',serif;font-weight:400;line-height:1.45;margin-bottom:18px}.summary{font-size:15px;line-height:1.9;color:var(--muted);white-space:pre-wrap;margin-bottom:26px}.draft-block{margin-top:32px;font-size:15px;line-height:1.9}.draft-block h3{margin-bottom:8px}.draft-gallery{display:grid;grid-template-columns:1fr 1fr;gap:18px}.draft-gallery.stack{grid-template-columns:1fr}figure{margin:0}figcaption{font-size:12px;color:var(--muted);text-align:center;padding-top:10px}blockquote{border-left:3px solid var(--green);padding:12px 24px;margin:0;white-space:pre-wrap}pre{overflow:auto;padding:20px;background:#e9ebe3;border-radius:6px;font-size:13px}.transcript{white-space:pre-wrap;margin-top:16px}.external-preview{padding:18px;background:#edf0e8;display:grid;gap:12px}.draft-paper a{color:var(--green);text-decoration:underline}.draft-paper :deep(.draft-richtext p){margin-block:12px}.draft-paper :deep(.draft-richtext h2),.draft-paper :deep(.draft-richtext h3){margin-block:20px 12px}.draft-paper :deep(.draft-richtext ul),.draft-paper :deep(.draft-richtext ol){padding-left:24px}@media(max-width:600px){.draft-paper h1{font-size:27px}.draft-gallery{grid-template-columns:1fr}.draft-block{font-size:14px}.draft-preview-dialog .dialog-head{gap:10px}}
</style>
