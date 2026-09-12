<script setup lang="ts">
const music = useMusic()
const audio = ref<HTMLAudioElement>()
onMounted(() => { if (audio.value) music.attach(audio.value); void music.refresh() })
onBeforeUnmount(() => music.detach())
</script>
<template><audio id="site-music" ref="audio" preload="none" /></template>
