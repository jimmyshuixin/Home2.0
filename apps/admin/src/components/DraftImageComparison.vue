<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { ContentBlock } from '@xvyin/contracts';
import ImageComparison from '../../../web/components/ImageComparison.vue';
import { errorMessage } from '../api';
import { privateMediaUrl, readMedia } from '../media';
const props = defineProps<{ block: Extract<ContentBlock, { type: 'compare' }> }>();
type Source = { url: string; width?: number; height?: number };
const beforeImage = ref<Source>(), afterImage = ref<Source>(), issue = ref(''), loading = ref(false);
let sequence = 0;
async function source(id: string): Promise<Source | undefined> {
  if (!id) return;
  const item = await readMedia(id);
  if (item.kind !== 'image' || (item.processingStatus || item.status) !== 'ready') throw new Error('双图对比需要已处理完成的图片。');
  const variant = ['content', 'large', 'thumb'].map(role => item.variants.find(value => value.role === role)).find(value => value?.width && value.height);
  const url = variant && privateMediaUrl(item, [variant.role]);
  if (!url || !variant) throw new Error('图片尚无具有尺寸的展示版本。');
  return { url, width: variant.width, height: variant.height };
}
async function load() {
  const current = ++sequence; issue.value = ''; loading.value = true; beforeImage.value = undefined; afterImage.value = undefined;
  const results = await Promise.allSettled([source(props.block.before.assetId), source(props.block.after.assetId)]);
  if (current !== sequence) return;
  if (results[0].status === 'fulfilled') beforeImage.value = results[0].value;
  if (results[1].status === 'fulfilled') afterImage.value = results[1].value;
  issue.value = results.flatMap(result => result.status === 'rejected' ? [errorMessage(result.reason)] : []).join(' ');
  loading.value = false;
}
watch(() => [props.block.before.assetId, props.block.after.assetId], load, { immediate: true });
onBeforeUnmount(() => { sequence++; });
</script>
<template><p v-if="loading" class="hint" role="status">正在读取对比图片…</p><div v-else><ImageComparison :block="block" :before-image="beforeImage" :after-image="afterImage"/><p v-if="issue" class="hint" role="status">{{ issue }} <button type="button" @click="load">重新读取</button></p></div></template>
