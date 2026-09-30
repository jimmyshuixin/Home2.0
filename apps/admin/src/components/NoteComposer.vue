<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ContentBlock } from '@xvyin/contracts';
import type { MediaItem } from '../api';
import RichTextEditor from './RichTextEditor.vue';
import AssetField from './AssetField.vue';
import MediaPicker from './MediaPicker.vue';
import BlockEditor from './BlockEditor.vue';

const props = defineProps<{ modelValue: ContentBlock[] }>();
const emit = defineEmits<{ 'update:modelValue': [blocks: ContentBlock[]] }>();
const pickerOpen = ref(false);
const hasOtherBlocks = computed(() => props.modelValue.some(block => !['richtext', 'image'].includes(block.type)));
function addText() {
  emit('update:modelValue', [...props.modelValue, { id: crypto.randomUUID(), type: 'richtext', document: { type: 'doc', content: [{ type: 'paragraph', content: [] }] } }]);
}
function addImages(items: MediaItem[]) {
  const images: ContentBlock[] = items.filter(item => item.kind === 'image' && (item.processingStatus || item.status) === 'ready').map(item => ({
    id: crypto.randomUUID(), type: 'image', assetId: item.id, variantRole: 'content',
    alt: (item.originalName || '随记图片').replace(/\.[^.]+$/, '').slice(0, 500), caption: '', alignment: 'center',
  }));
  emit('update:modelValue', [...props.modelValue, ...images].slice(0, 200));
}
function remove(index: number) { emit('update:modelValue', props.modelValue.filter((_, position) => position !== index)); }
function move(index: number, direction: number) {
  const blocks = [...props.modelValue], target = index + direction;
  if (target < 0 || target >= blocks.length) return;
  const block = blocks.splice(index, 1)[0]; if (!block) return;
  blocks.splice(target, 0, block); emit('update:modelValue', blocks);
}
</script>
<template>
  <section class="note-composer" aria-label="随记正文">
    <div class="note-intro"><p class="eyebrow">A LITTLE NOTE</p><h2>把这一刻写下来。</h2><p class="hint mt16">不用起标题。一句话、几张照片，都可以成为一则随记。</p></div>
    <BlockEditor v-if="hasOtherBlocks" :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" />
    <template v-else>
      <article v-for="(block, index) in modelValue" :key="block.id" class="note-piece">
        <div class="flex between mb16"><span class="hint">{{ block.type === 'richtext' ? '文字' : '图片' }} {{ index + 1 }}</span><div class="flex"><button type="button" :disabled="index === 0" :aria-label="`第${index + 1}项上移`" @click="move(index, -1)">↑</button><button type="button" :disabled="index === modelValue.length - 1" :aria-label="`第${index + 1}项下移`" @click="move(index, 1)">↓</button><button type="button" :aria-label="`移除第${index + 1}项`" @click="remove(index)">移除</button></div></div>
        <RichTextEditor v-if="block.type === 'richtext'" v-model="block.document" label="随记文字" />
        <template v-else-if="block.type === 'image'"><AssetField v-model="block.assetId" label="随记图片" kind="image"/><label class="field mt16">图片描述<input v-model="block.alt" maxlength="500" placeholder="简短说明画面内容，供无法看图的访客阅读"></label><label class="field">图注，可选<input v-model="block.caption" maxlength="1000"></label></template>
      </article>
      <div class="note-add"><button type="button" :disabled="modelValue.length >= 200" @click="addText">＋ 写文字</button><button type="button" :disabled="modelValue.length >= 200" @click="pickerOpen = true">＋ 上传或选择图片</button></div>
    </template>
    <MediaPicker v-if="pickerOpen" kind="image" title="为随记添加图片" multiple :max-selected="200 - modelValue.length" @close="pickerOpen = false" @select-many="addImages" />
  </section>
</template>
<style scoped>
.note-intro{padding:12px 0 24px}.note-intro h2{font-family:Georgia,'STKaiti','KaiTi',serif;font-weight:400;font-size:30px;margin-top:12px}.note-piece{margin:0 0 22px;padding:22px;background:var(--panel, #fafaf6);border:1px solid var(--line)}.note-piece>.flex{gap:12px;flex-wrap:wrap}.note-add{display:flex;gap:12px;flex-wrap:wrap}@media(max-width:600px){.note-piece{padding:14px}.note-add button{flex:1}.note-intro h2{font-size:26px}}
</style>
