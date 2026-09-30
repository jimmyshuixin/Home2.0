<script setup lang="ts">
import { computed } from 'vue';
import { assetVariant, assetSrcSet, type Creation } from '~/lib/site';
import { noteDate } from '~/lib/notes';
import { creationPlain } from '~/lib/publication-metadata';
const props = defineProps<{ entry: Creation; compact?: boolean }>();
const excerpt = computed(() => { const text = creationPlain(props.entry); return Array.from(text).slice(0, 180).join('') + (Array.from(text).length > 180 ? '…' : ''); });
const image = computed(() => props.entry.blocks.find(block => block.type === 'image'));
</script>
<template>
  <article class="note-card" :class="{ compact }" :aria-label="`${noteDate(entry.publishedAt)}的随记`">
    <header class="note-meta"><span>随记</span><NuxtLink :to="`/creations/${entry.slug}`" :aria-label="`阅读${noteDate(entry.publishedAt)}的随记`"><time :datetime="entry.publishedAt">{{ noteDate(entry.publishedAt) }}</time></NuxtLink></header>
    <div class="note-content prose"><template v-if="compact"><p class="note-excerpt">{{ excerpt }}</p><img v-if="image?.type === 'image' && assetVariant(image.assetId)" class="note-preview" :src="assetVariant(image.assetId)?.url" :srcset="assetSrcSet(image.assetId)" sizes="(max-width:600px) 90vw, 560px" :alt="image.alt" :width="assetVariant(image.assetId)?.width" :height="assetVariant(image.assetId)?.height" loading="lazy" decoding="async"></template><ContentBlocks v-else :blocks="entry.blocks" /></div>
    <footer class="note-foot"><span v-if="entry.tags.length" class="small muted">{{ entry.tags.join(' / ') }}</span><NuxtLink class="text-link" :to="`/creations/${entry.slug}`">{{ compact ? '读这则随记' : '查看随记与留言' }}<SiteIcon name="arrow" :size="16" /></NuxtLink></footer>
  </article>
</template>
<style scoped>
.note-card{padding:30px 0 38px;border-bottom:1px solid var(--line, #d9d6cb);min-width:0}.note-meta{display:flex;gap:16px;align-items:center;color:var(--muted);font-size:12px;letter-spacing:.08em}.note-meta>span{color:var(--accent, #52644c)}.note-meta a{text-decoration:none}.note-content{margin-top:18px;overflow-wrap:anywhere}.note-content :deep(.content-block){margin-top:22px}.note-foot{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:22px;flex-wrap:wrap}.note-foot .text-link{margin-left:auto}.note-excerpt{white-space:pre-wrap}.note-preview{display:block;max-height:260px;width:100%;object-fit:cover;margin-top:18px}@media(max-width:600px){.note-card{padding:24px 0 30px}.note-meta{font-size:11px}.note-foot{gap:12px}}
</style>
