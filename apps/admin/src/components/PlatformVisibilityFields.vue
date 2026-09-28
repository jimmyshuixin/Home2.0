<script setup lang="ts">
import type { SocialVisibility } from '@xvyin/contracts';

const props = defineProps<{ modelValue: SocialVisibility }>();
const emit = defineEmits<{ 'update:modelValue': [value: SocialVisibility] }>();
const platforms = [
  { key: 'bilibili', label: '显示 B站资料与作品' },
  { key: 'douyin', label: '显示抖音资料与主页作品' },
  { key: 'github', label: '显示 GitHub 资料与项目' },
] as const;
function change(platform: keyof SocialVisibility, event: Event) {
  emit('update:modelValue', { ...props.modelValue, [platform]: (event.target as HTMLInputElement).checked });
}
</script>

<template>
  <section class="panel mt24" aria-labelledby="platform-visibility-title">
    <h2 id="platform-visibility-title">关于页平台展示</h2>
    <p class="hint mt16">选择关于页展示的平台。保存草稿后，发布才会更新前台。</p>
    <div class="mt24">
      <label v-for="platform in platforms" :key="platform.key" class="check mt16">
        <input type="checkbox" :checked="modelValue[platform.key]" @change="change(platform.key, $event)">{{ platform.label }}
      </label>
    </div>
    <p class="hint mt16">关闭仅隐藏关于页对应模块，不会停止公开资料的定时更新。</p>
  </section>
</template>
