<script setup lang="ts">
const props = defineProps<{ modelValue: boolean; title: string; wide?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const element = ref<HTMLDialogElement>()
const titleId = useId()
let returnFocus: HTMLElement | null = null
watch(() => props.modelValue, (value) => {
  if (!element.value) return
  if (value) { returnFocus = document.activeElement as HTMLElement; element.value.showModal(); document.documentElement.style.overflow = 'hidden' }
  else { element.value.close(); document.documentElement.style.overflow = ''; returnFocus?.focus() }
})
function close() { emit('update:modelValue', false) }
onBeforeUnmount(() => { document.documentElement.style.overflow = '' })
</script>
<template><dialog ref="element" :aria-labelledby="titleId" :class="{ 'dialog-wide': wide }" @cancel.prevent="close" @click="($event.target === element) && close()"><div class="dialog-head"><h2 :id="titleId">{{ title }}</h2><button class="icon-button" aria-label="关闭" @click="close"><SiteIcon name="close" /></button></div><slot /></dialog></template>
