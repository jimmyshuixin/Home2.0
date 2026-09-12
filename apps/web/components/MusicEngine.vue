<script setup lang="ts">
const music = useMusic()
const { source, position, duration, playing, volume, repeat, error } = music
function sync(event: Event) { const audio = event.target as HTMLAudioElement; position.value = audio.currentTime; duration.value = audio.duration; playing.value = !audio.paused && !audio.ended }
onMounted(() => { const audio = document.getElementById('site-music') as HTMLAudioElement; audio.volume = volume.value; void music.refresh() })
</script>
<template><audio id="site-music" :src="source" preload="none" :loop="repeat" @timeupdate="sync" @durationchange="sync" @play="sync" @pause="sync" @ended="sync" @error="error = '歌曲暂时无法播放，请重试或切换歌单。'; playing = false" /></template>
