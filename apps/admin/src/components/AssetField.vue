<script setup lang="ts">
import { ref } from 'vue';
import MediaPicker from './MediaPicker.vue';
import MediaPreview from './MediaPreview.vue';
import type { MediaItem } from '../api';
const props = defineProps<{ modelValue?: string | null; label: string; kind?: string; optional?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string | null]; selected: [item: MediaItem] }>();
const open = ref(false); const selectedName = ref('');
function select(item: MediaItem) { emit('update:modelValue', item.id); emit('selected', item); selectedName.value = item.originalName || ''; }
</script>
<template><div class="field"><span class="field-label">{{ label }}</span><MediaPreview v-if="modelValue" :asset-id="modelValue" :label="label"/><div class="asset-field"><span :class="{muted:!modelValue}">{{ modelValue ? (selectedName || '已关联媒体') : '尚未选择' }}</span><div class="flex"><button type="button" @click="open=true">{{ modelValue ? '更换 / 上传' : '上传或选择媒体' }}</button><button v-if="modelValue && optional" type="button" @click="emit('update:modelValue', null); selectedName=''">清除</button></div></div><details v-if="modelValue" class="hint asset-id"><summary>媒体编号</summary>{{ modelValue }}</details><MediaPicker v-if="open" :kind="kind" :title="label" @close="open=false" @select="select"></MediaPicker></div></template>
