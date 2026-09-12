<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 22 })
const paths: Record<string, string> = {
  menu: 'M4 6h16M4 12h16M4 18h16', close: 'm5 5 14 14M19 5 5 19', arrow: 'M4 12h16m-6-6 6 6-6 6', back: 'M20 12H4m6-6-6 6 6 6', external: 'M7 17 18 6M6 6h12v12', play: 'm8 5 11 7-11 7z', pause: 'M8 5v14M16 5v14', previous: 'M5 5v14m14-14L8 12l11 7z', next: 'M19 5v14M5 5l11 7-11 7z', volume: 'M3 9h4l5-4v14l-5-4H3zM16 8c3 2 3 6 0 8M19 5c5 4 5 10 0 14', repeat: 'M5 7h14l-3-3m3 3-3 3M19 17H5l3 3m-3-3 3-3M3 8v5M21 16v-5', expand: 'M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7', file: 'M6 3h9l4 4v14H6zM15 3v5h4M9 13h7M9 17h5', music: 'M9 18V5l11-2v13M9 6l11-2M9 17c-5-3-8 4-3 4 2 0 3-2 3-4M20 15c-5-3-8 4-3 4 2 0 3-2 3-4', download: 'M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4'
}
</script>
<template><svg :width="size" :height="size" viewBox="0 0 24 24" class="icon" aria-hidden="true"><path :d="paths[name] || paths.arrow" /></svg></template>
