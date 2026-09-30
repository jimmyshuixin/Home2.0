<script setup lang="ts">
import { createSearchClient, SearchUnavailable, type SearchResult } from '~/lib/search-client'
import { SEARCH_CATEGORIES, SEARCH_QUERY_LIMIT, type SearchCategory } from '~/lib/search-shared'

const props = defineProps<{ releaseId: string }>()
const client = createSearchClient(props.releaseId)
const route = useRoute(), router = useRouter()
const query = ref(''), category = ref<SearchCategory | ''>(''), results = ref<SearchResult[]>([])
const total = ref(0), submitted = ref(''), busy = ref(false), searched = ref(false), message = ref('')
const outdated = ref(false), composing = ref(false), input = ref<HTMLInputElement | null>(null)
let sequence = 0, mounted = false
const remaining = computed(() => Math.max(0, total.value - results.value.length))
const queryTooLong = computed(() => Array.from(query.value.trim()).length > SEARCH_QUERY_LIMIT)
const countMessage = computed(() => busy.value ? '正在查找…' : !searched.value ? '' : total.value ? `找到 ${total.value} 条内容，已显示 ${results.value.length} 条。` : '没有找到相关内容。')
function routeState() {
  query.value = typeof route.query.q === 'string' ? route.query.q : ''
  const value = typeof route.query.category === 'string' ? route.query.category : ''
  category.value = Object.hasOwn(SEARCH_CATEGORIES, value) ? value as SearchCategory : ''
}
async function search(append = false) {
  const term = query.value.trim()
  // Editing the input must not append a different query to the visible page.
  if (append && term !== submitted.value) return
  const current = ++sequence
  message.value = ''; outdated.value = false
  if (!term || queryTooLong.value) {
    results.value = []; total.value = 0; searched.value = false; busy.value = false
    if (queryTooLong.value) message.value = `请把关键词控制在 ${SEARCH_QUERY_LIMIT} 个字以内。`
    return
  }
  if (!append) { results.value = []; total.value = 0 }
  busy.value = true; searched.value = true; submitted.value = term
  try {
    const page = await client.search(term, category.value || undefined, append ? results.value.length : 0)
    if (current !== sequence) return
    total.value = page.total
    results.value = append ? [...results.value, ...page.results] : page.results
  } catch (error) {
    if (current !== sequence) return
    outdated.value = error instanceof SearchUnavailable && error.reason === 'version-unavailable'
    message.value = outdated.value ? '页面版本已更新，刷新页面后即可继续搜索。' : '搜索暂时未能加载，请稍后重试。'
  } finally { if (current === sequence) busy.value = false }
}
async function submit() {
  if (composing.value) return
  const q = query.value.trim(), next = { ...(q ? { q } : {}), ...(category.value ? { category: category.value } : {}) }
  if (route.query.q === q && (route.query.category || '') === category.value) { await search(); return }
  await router.replace({ path: '/search', query: next })
}
async function filter(value: SearchCategory | '') {
  category.value = value
  await submit()
}
async function retry() {
  ++sequence
  busy.value = true
  await client.reset()
  await search()
}
async function clear() {
  ++sequence
  query.value = ''; results.value = []; total.value = 0; searched.value = false; busy.value = false; message.value = ''
  await router.replace({ path: '/search', query: category.value ? { category: category.value } : {} })
  input.value?.focus()
}
watch(() => [route.query.q, route.query.category], () => {
  if (!mounted) return
  routeState(); void search()
})
onMounted(() => { mounted = true; routeState(); if (query.value.trim()) void search() })
onBeforeUnmount(() => { mounted = false; ++sequence; void client.reset() })
</script>

<template>
  <section class="site-search" aria-label="搜索公开内容">
    <form class="search-form" role="search" @submit.prevent="submit">
      <label for="site-search-input">想找哪一段文字，或哪一张风景？</label>
      <div class="site-search-field">
        <input id="site-search-input" ref="input" v-model="query" type="search" name="q" placeholder="试试正文中的词语、照片说明…" autocomplete="off" enterkeyhint="search" aria-describedby="search-scope" :aria-invalid="queryTooLong || undefined" @compositionstart="composing = true" @compositionend="composing = false">
        <button type="submit" class="button primary" :disabled="busy || composing">查找<SiteIcon name="arrow" :size="17" /></button>
      </div>
      <p id="search-scope" class="search-note">在创作正文、摄影说明、关于与公开日常中寻找。</p>
    </form>
    <div class="search-toolbar">
      <div class="filters search-categories" role="group" aria-label="搜索栏目">
        <button type="button" :aria-pressed="!category" @click="filter('')">全部</button>
        <button v-for="(label, value) in SEARCH_CATEGORIES" :key="value" type="button" :aria-pressed="category === value" @click="filter(value)">{{ label }}</button>
      </div>
      <button v-if="query" type="button" class="search-clear" @click="clear">清空关键词</button>
    </div>
    <p class="search-status" aria-live="polite" aria-atomic="true">{{ message ? '' : countMessage }}</p>
    <div v-if="message" class="search-message" role="alert">
      <p>{{ message }}</p>
      <a v-if="outdated" class="button" :href="route.fullPath">刷新页面</a>
      <button v-else-if="!queryTooLong" class="button" type="button" :disabled="busy" @click="retry">重新尝试</button>
    </div>
    <ol v-if="results.length" class="search-results" :aria-busy="busy">
      <li v-for="result in results" :key="result.url">
        <p class="result-meta"><span>{{ SEARCH_CATEGORIES[result.category] }}</span><time v-if="result.publishedAt" :datetime="result.publishedAt">{{ result.publishedAt.slice(0, 10).replaceAll('-', '.') }}</time></p>
        <h2><NuxtLink :to="result.url">{{ result.title }}<SiteIcon name="arrow" :size="19" /></NuxtLink></h2>
        <p class="result-excerpt"><template v-for="(part, index) in result.excerpt" :key="index"><mark v-if="part.highlighted">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></p>
      </li>
    </ol>
    <div v-else-if="searched && !busy && !message" class="search-empty">
      <p>暂时没有与“{{ submitted }}”相关的内容。</p>
      <p class="muted">可以换个短一些的词语，或选择全部栏目再找找。</p>
    </div>
    <div v-else-if="!searched && !message" class="search-invitation" aria-hidden="true"><span class="ink-line" /><p>循着一个词，<br>重逢一段日常。</p></div>
    <div v-if="results.length && remaining && query.trim() === submitted" class="search-more"><button class="button" type="button" :disabled="busy" @click="search(true)">{{ busy ? '正在加载…' : `继续查看（还有 ${remaining} 条）` }}</button></div>
  </section>
</template>

<style scoped>
.site-search{max-width:850px;margin:0 auto 96px}.search-form label{display:block;font-size:20px;line-height:1.7;margin-bottom:17px;color:var(--ink,#292822)}.site-search-field{display:flex;gap:14px;align-items:stretch}.site-search-field input{flex:1;min-width:0;background:rgba(255,255,255,.27);border:1px solid rgba(68,62,46,.25);border-radius:3px;padding:16px 18px;font:inherit;font-size:18px;color:inherit;outline-offset:5px}.site-search-field input:focus-visible{outline:2px solid var(--accent,#8b493c)}.site-search-field .button{flex-shrink:0;min-width:110px}.search-note{font-size:13px;color:var(--muted,#79756b);margin:13px 0 29px;line-height:1.8}.search-toolbar{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap}.search-categories{margin:0;gap:8px}.search-clear{font:inherit;font-size:13px;color:var(--muted,#79756b);text-decoration:underline;text-underline-offset:4px;background:none;border:0;padding:8px;cursor:pointer}.search-status{font-size:13px;color:var(--muted,#79756b);min-height:24px;margin:25px 0 6px}.search-results{list-style:none;margin:0;padding:0}.search-results li{padding:26px 0 29px;border-bottom:1px solid rgba(91,81,61,.16)}.result-meta{display:flex;align-items:center;gap:17px;font-size:12px;letter-spacing:.1em;color:var(--muted,#79756b);margin:0 0 12px}.search-results h2{font-size:25px;line-height:1.55;margin:0 0 13px;font-weight:600}.search-results h2 a{display:flex;align-items:center;justify-content:space-between;gap:16px;color:inherit;text-decoration:none}.search-results h2 a:hover{color:var(--accent,#8b493c)}.result-excerpt{font-size:16px;line-height:1.95;color:var(--muted,#666158);margin:0;overflow-wrap:anywhere}.result-excerpt mark{background:rgba(168,114,62,.17);color:var(--ink,#292822);padding:1px 2px;border-radius:2px}.search-message,.search-empty{padding:30px 0;font-size:16px;line-height:1.9}.search-message .button{margin-top:10px}.search-empty .muted{font-size:14px}.search-invitation{display:flex;align-items:center;gap:28px;margin:75px 0 100px 12%;color:var(--muted,#777164)}.search-invitation p{font-size:25px;line-height:2;letter-spacing:.13em}.ink-line{height:86px;width:2px;background:linear-gradient(transparent,rgba(90,73,45,.45),transparent)}.search-more{text-align:center;margin-top:30px}button:disabled{cursor:wait;opacity:.65}@media(max-width:600px){.site-search{margin-bottom:62px}.search-form label{font-size:17px}.site-search-field{gap:9px}.site-search-field input{font-size:16px;padding:13px 12px}.site-search-field .button{min-width:77px;padding-left:12px;padding-right:12px}.search-note{font-size:12px;margin-bottom:22px}.search-toolbar{gap:8px}.search-categories{gap:3px}.search-categories button{padding:7px 10px}.search-results h2{font-size:22px}.result-excerpt{font-size:15px}.search-invitation{margin:40px 0 70px 8%}.search-invitation p{font-size:22px}.search-status{margin-top:18px}}
</style>
