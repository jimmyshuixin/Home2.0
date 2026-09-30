<script setup lang="ts">
import { site } from '~/lib/site';
import { publishedNotes } from '~/lib/notes';
const route = useRoute();
const notes = publishedNotes(site.creations);
// Static HTML is shared by all query strings; apply filters after hydration.
const query = ref<Record<string, unknown>>({});
onMounted(() => { query.value = route.query; });
watch(() => route.query, value => { query.value = value; });
const tag = computed(() => typeof query.value.tag === 'string' ? query.value.tag : '');
const tags = [...new Set(notes.flatMap(note => note.tags))].sort();
const filtered = computed(() => notes.filter(note => !tag.value || note.tags.includes(tag.value)));
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / 12)));
const page = computed(() => Math.min(pageCount.value, Math.max(1, Math.floor(Number(query.value.page) || 1))));
const visible = computed(() => filtered.value.slice((page.value - 1) * 12, page.value * 12));
useSeoMeta({ title: '随记 · 虚宁', description: '一些短短的文字，和日常里想留下的画面。' });
</script>
<template>
  <section class="page-heading"><h1>随记<span class="dot" aria-hidden="true" /></h1><p>一些短短的文字，和日常里想留下的画面。</p><NuxtLink class="text-link" to="/now">看看近况<SiteIcon name="arrow" :size="16" /></NuxtLink></section>
  <div class="notes-page"><nav v-if="tags.length" class="note-tags" aria-label="随记主题"><NuxtLink :to="{ query: {} }" :aria-current="!tag ? 'page' : undefined">全部</NuxtLink><NuxtLink v-for="item in tags" :key="item" :to="{ query: { tag: item } }" :aria-current="tag === item ? 'page' : undefined">{{ item }}</NuxtLink></nav>
    <div v-if="visible.length"><p class="small muted" role="status">{{ filtered.length }} 则随记</p><NoteCard v-for="entry in visible" :key="entry.id" :entry="entry" /></div>
    <div v-else class="empty-state"><h2>{{ notes.length ? '这个主题还没有随记' : '还没有公开随记' }}</h2><p>{{ notes.length ? '换个主题，看看其他日常。' : '等有想记下的一刻，再慢慢写在这里。' }}</p><NuxtLink v-if="tag" class="text-link" to="/notes">查看全部随记</NuxtLink><NuxtLink v-else class="text-link" to="/creations">先去看看创作</NuxtLink></div>
    <nav v-if="pageCount > 1" class="pagination" aria-label="随记分页"><NuxtLink v-for="n in pageCount" :key="n" :to="{ query: { ...(tag ? { tag } : {}), ...(n > 1 ? { page: n } : {}) } }" :aria-current="page === n ? 'page' : undefined">{{ n }}</NuxtLink></nav>
  </div>
</template>
<style scoped>
.notes-page{max-width:780px;margin:0 auto}.page-heading .text-link{margin-top:20px}.note-tags{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px}.note-tags a{font-size:13px;padding:7px 12px;border:1px solid var(--line);text-decoration:none}.note-tags a[aria-current=page]{color:var(--paper,#fff);background:var(--ink,#363b30)}
</style>
