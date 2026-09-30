<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import type { ContentBlock } from '@xvyin/contracts'

// The same view renders public variants and authenticated draft variants.
// It never resolves original media or turns asset IDs into arbitrary URLs.
type ImageSource = { url: string; width?: number; height?: number }
const props = defineProps<{
  block: Extract<ContentBlock, { type: 'compare' }>
  beforeImage?: ImageSource
  afterImage?: ImageSource
}>()
const mode = ref(props.block.mode || 'side-by-side'), position = ref(50)
const failed = ref<Record<string, boolean>>({})
watch(() => props.block.mode, value => { mode.value = value || 'side-by-side' })
const pictures = computed(() => [
  { key: 'before', detail: props.block.before, source: props.beforeImage, label: props.block.before.label || '第一张' },
  { key: 'after', detail: props.block.after, source: props.afterImage, label: props.block.after.label || '第二张' },
])
const ratio = (source?: ImageSource) => source?.width && source?.height ? source.width / source.height : 4 / 3
const sliderRatio = computed(() => ratio(props.beforeImage || props.afterImage))
const ready = computed(() => pictures.value.every(picture => picture.source && !failed.value[picture.source.url]))
const sliderId = `comparison-position-${useId()}`
</script>

<template>
  <figure class="image-comparison">
    <div class="comparison-toolbar" role="group" aria-label="双图对比显示方式">
      <span class="comparison-heading">双图对比</span>
      <button type="button" :aria-pressed="mode === 'side-by-side' || !ready" @click="mode = 'side-by-side'">并排</button>
      <button type="button" :aria-pressed="mode === 'slider' && ready" :disabled="!ready" @click="mode = 'slider'">滑动</button>
    </div>
    <div v-if="mode !== 'slider' || !ready" class="comparison-pair">
      <div v-for="picture in pictures" :key="picture.key" class="comparison-picture">
        <div class="comparison-frame" :style="{ aspectRatio: ratio(picture.source) }">
          <img v-if="picture.source && !failed[picture.source.url]" :src="picture.source.url" :width="picture.source.width" :height="picture.source.height" :alt="picture.detail.alt" loading="lazy" decoding="async" @error="failed[picture.source.url] = true">
          <div v-else class="comparison-placeholder" role="status"><span>{{ picture.detail.assetId ? '图片暂时无法显示' : '尚未选择图片' }}</span><button v-if="picture.source" type="button" @click="failed[picture.source.url] = false">重新加载</button></div>
        </div>
        <p class="comparison-label">{{ picture.label }}</p>
      </div>
    </div>
    <div v-else class="comparison-slider">
      <div class="comparison-stage" :style="{ aspectRatio: sliderRatio }">
        <img :src="afterImage!.url" :width="afterImage!.width" :height="afterImage!.height" :alt="block.after.alt" loading="lazy" decoding="async" @error="failed[afterImage!.url] = true">
        <div class="comparison-overlay" :style="{ clipPath: `inset(0 ${100 - position}% 0 0)` }"><img :src="beforeImage!.url" :width="beforeImage!.width" :height="beforeImage!.height" :alt="block.before.alt" loading="lazy" decoding="async" @error="failed[beforeImage!.url] = true"></div>
        <span class="comparison-divider" :style="{ left: `${position}%` }" aria-hidden="true" />
      </div>
      <div class="comparison-labels"><span>{{ pictures[0]!.label }}</span><span>{{ pictures[1]!.label }}</span></div>
      <label class="comparison-range-label" :for="sliderId">拖动或使用方向键比较两张图片</label>
      <input :id="sliderId" v-model.number="position" class="comparison-range" type="range" min="0" max="100" step="1" :aria-valuetext="`${pictures[0]!.label}显示 ${position}%，${pictures[1]!.label}显示 ${100 - position}%`">
    </div>
    <figcaption v-if="block.caption">{{ block.caption }}</figcaption>
  </figure>
</template>

<style scoped>
.image-comparison{margin:0;width:100%;min-width:0;padding-block:12px}.comparison-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap}.comparison-heading{margin-right:auto;font-size:12px;letter-spacing:.1em;color:var(--muted,#66665b)}.comparison-toolbar button,.comparison-placeholder button{font:inherit;font-size:12px;color:var(--ink,#282a23);border:1px solid var(--line,#d8d6c9);background:transparent;padding:6px 13px;min-height:36px;border-radius:2px;cursor:pointer}.comparison-toolbar button[aria-pressed=true]{color:var(--green,#3d5446);border-color:var(--green,#3d5446);background:rgba(77,97,73,.07)}.comparison-toolbar button:disabled{opacity:.4;cursor:default}.comparison-toolbar button:focus-visible,.comparison-range:focus-visible,.comparison-placeholder button:focus-visible{outline:2px solid var(--green,#3d5446);outline-offset:4px}.comparison-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:clamp(10px,2vw,22px)}.comparison-picture{min-width:0}.comparison-frame,.comparison-stage{position:relative;width:100%;overflow:hidden;background:rgba(94,86,61,.055)}.comparison-frame img,.comparison-stage img{display:block;width:100%;height:100%;max-height:none;object-fit:contain;margin:0;border-radius:0}.comparison-frame img{position:absolute;inset:0}.comparison-label,.comparison-labels{font-size:13px;line-height:1.7;margin:9px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted,#66665b)}.comparison-stage>img,.comparison-overlay{position:absolute;inset:0;width:100%;height:100%}.comparison-overlay{background:var(--paper,#f7f3e9)}.comparison-divider{position:absolute;top:0;bottom:0;width:2px;background:var(--paper,#f7f3e9);box-shadow:0 0 0 1px rgba(40,42,35,.35);transform:translateX(-1px);pointer-events:none}.comparison-labels{display:flex;justify-content:space-between;gap:16px}.comparison-labels>span{max-width:48%}.comparison-labels>span:last-child{text-align:right}.comparison-range-label{display:block;font-size:12px;line-height:1.8;color:var(--muted,#66665b);margin-top:18px}.comparison-range{display:block;width:100%;height:36px;min-height:36px;margin:0;padding:0;accent-color:var(--green,#3d5446);cursor:ew-resize;touch-action:pan-y;background:transparent}.comparison-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;font-size:12px;text-align:center;padding:12px;color:var(--muted,#66665b)}figcaption{margin-top:14px;font-size:13px;line-height:1.8;color:var(--muted,#66665b);white-space:pre-wrap;overflow-wrap:anywhere;text-align:left}@media(max-width:480px){.comparison-label,.comparison-labels,figcaption{font-size:12px}}
</style>
