<script setup lang="ts">
import type { Now } from '@xvyin/contracts';
defineProps<{ modelValue?: Now }>();
const emit = defineEmits<{ 'update:modelValue': [value: Now] }>();
function update(current: Now | undefined, values: Partial<Now>) { emit('update:modelValue', { enabled: false, text: '', updatedAt: null, ...current, ...values }); }
</script>
<template>
  <section class="panel mt24" aria-labelledby="now-editor-title">
    <p class="eyebrow">NOW</p><h2 id="now-editor-title" class="mt16">近况</h2><p class="hint mt16">写一点最近在做、在读、在练的事情。保存和发布后，访客才能看到更新；留空时显示暂无更新。</p>
    <label class="field mt24">近况正文<textarea :value="modelValue?.text || ''" maxlength="2000" rows="6" placeholder="从最近的一件小事写起，也可以暂时留空。" @input="update(modelValue, { text: ($event.target as HTMLTextAreaElement).value })"></textarea></label>
    <label class="check"><input type="checkbox" :checked="modelValue?.enabled || false" @change="update(modelValue, { enabled: ($event.target as HTMLInputElement).checked })">发布后公开这段近况</label>
    <p class="hint mt16">关闭时，正文不会进入公开数据。修改正文并保存会记录真实的更新时间。</p>
  </section>
</template>
