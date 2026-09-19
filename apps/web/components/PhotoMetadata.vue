<script setup lang="ts">
import { assetPhotography } from '~/lib/site'
import { photographyRows } from '~/lib/photography'
const props = defineProps<{ assetId: string; hideDate?: boolean; expanded?: boolean }>()
const rows = computed(() => photographyRows(assetPhotography(props.assetId), props.hideDate))
</script>
<template><details v-if="rows.length" class="photo-metadata" :open="expanded"><summary>拍摄信息<span v-if="rows[0]?.label === '相机'"> · {{ rows[0].value }}</span></summary><dl><div v-for="row in rows" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div></dl><p>来自照片文件中的拍摄记录</p></details></template>
<style scoped>.photo-metadata{margin:10px 0 0;color:var(--muted);font-size:12px;line-height:1.7;min-width:0}.photo-metadata summary{cursor:pointer;min-height:32px;overflow-wrap:anywhere}.photo-metadata summary span{color:var(--ink);opacity:.75}.photo-metadata dl{display:flex;flex-wrap:wrap;gap:10px 24px;margin:8px 0 0}.photo-metadata dl>div{display:flex;gap:10px;min-width:0}.photo-metadata dt{white-space:nowrap}.photo-metadata dd{margin:0;color:var(--ink);overflow-wrap:anywhere}.photo-metadata p{font-size:10px;margin:8px 0 0}</style>
