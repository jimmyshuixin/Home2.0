<script setup lang="ts">
import { assetPhotography } from '~/lib/site'
import {
  emptyPhotoFilters, filterPhotoEntries, photoExplorerEntries, photoExplorerPage,
  photoExplorerQuery, photoExplorerQueryValues, photoFilterKeys, photoFilterOptions,
  type ExplorerAlbum, type PhotoFilterKey,
} from '~/lib/photo-explorer'

const props = defineProps<{ albums: ExplorerAlbum[] }>()
const route = useRoute(), router = useRouter()
const state = computed(() => photoExplorerQuery(route.query))
const entries = computed(() => photoExplorerEntries(props.albums, assetPhotography))
const matching = computed(() => filterPhotoEntries(entries.value, state.value.filters))
const result = computed(() => photoExplorerPage(matching.value, state.value.page))
const labels: Record<PhotoFilterKey, string> = { year: '拍摄年份', camera: '相机', lens: '镜头', focal: '焦距' }
const options = computed(() => Object.fromEntries(photoFilterKeys.map(key => [key, photoFilterOptions(entries.value, state.value.filters, key)])) as Record<PhotoFilterKey, ReturnType<typeof photoFilterOptions>>)
const active = computed(() => photoFilterKeys.filter(key => state.value.filters[key]).map(key => ({ key, label: options.value[key].find(option => option.value === state.value.filters[key])?.label || state.value.filters[key] })))
const pictures = computed(() => result.value.entries.map((entry, index) => ({ ...entry.photo, sortOrder: index })))
const contexts = computed(() => Object.fromEntries(result.value.entries.map(entry => [entry.key, entry.context])))
const resultHeading = ref<HTMLElement>(), copied = ref(false), copyFailed = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | undefined

function apply(key?: PhotoFilterKey, value = '') {
  const filters = key ? { ...state.value.filters, [key]: value } : emptyPhotoFilters()
  copied.value = false; copyFailed.value = false
  router.replace({ query: { ...route.query, ...photoExplorerQueryValues(filters) } })
}
async function turnPage(page: number) {
  await router.replace({ query: { ...route.query, ...photoExplorerQueryValues(state.value.filters, page) } })
  await nextTick()
  resultHeading.value?.focus({ preventScroll: true })
  resultHeading.value?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
}
async function copyLink() {
  copied.value = false; copyFailed.value = false
  try {
    // Keep only this public browsing state, never a preview token or unrelated URL parameter.
    const path = router.resolve({ path: '/photography', query: photoExplorerQueryValues(state.value.filters, result.value.page) }).href
    await navigator.clipboard.writeText(new URL(path, window.location.origin).href)
    copied.value = true
    clearTimeout(copyTimer); copyTimer = setTimeout(() => { copied.value = false }, 3000)
  } catch { copyFailed.value = true }
}
onBeforeUnmount(() => clearTimeout(copyTimer))
</script>

<template>
  <section class="photo-explorer" aria-label="全部照片">
    <header class="explorer-heading">
      <div><h2>循着光线，慢慢看</h2><p>按拍摄年份与器材，找到同一种视角。</p></div>
      <span class="explorer-total">{{ entries.length }} 张照片</span>
    </header>
    <template v-if="entries.length">
      <div class="explorer-filters" role="group" aria-label="筛选照片">
        <label v-for="key in photoFilterKeys" :key="key">
          <span>{{ labels[key] }}</span>
          <select :value="state.filters[key]" @change="apply(key, ($event.target as HTMLSelectElement).value)">
            <option value="">全部{{ key === 'year' ? '年份' : labels[key] }}</option>
            <option v-if="state.filters[key] && !options[key].some(option => option.value === state.filters[key])" :value="state.filters[key]">链接中的条件（已无记录）</option>
            <option v-for="option in options[key]" :key="option.value" :value="option.value">{{ option.label }} · {{ option.count }}</option>
          </select>
        </label>
      </div>
      <p class="explorer-note">年份采用照片中的拍摄记录或作者校正日期；未记录的信息会单独列出。</p>
      <div v-if="active.length" class="explorer-active" aria-label="已选筛选条件">
        <button v-for="filter in active" :key="filter.key" type="button" :aria-label="`取消${labels[filter.key]}筛选：${filter.label}`" @click="apply(filter.key)">{{ filter.label }}<span aria-hidden="true">×</span></button>
        <button type="button" class="explorer-clear" @click="apply()">清除筛选</button>
      </div>
      <div class="explorer-results-heading">
        <h3 ref="resultHeading" tabindex="-1" aria-live="polite" aria-atomic="true">{{ matching.length }} 张<span v-if="active.length">符合条件</span><span v-else>光影片刻</span><small v-if="result.pageCount > 1"> · 第 {{ result.start }}–{{ result.end }} 张</small></h3>
        <button type="button" class="explorer-share" @click="copyLink">{{ copied ? '链接已复制' : '分享此刻的选择' }}<SiteIcon name="arrow" :size="14" /></button>
      </div>
      <p v-if="copied" class="explorer-feedback" role="status">已复制当前筛选与页码的链接。</p>
      <p v-if="copyFailed" class="explorer-feedback" role="status">暂时无法复制，可从浏览器地址栏分享当前选择。</p>
      <PhotoGallery v-if="matching.length" :key="JSON.stringify([state.filters, result.page])" :photos="pictures" :photo-contexts="contexts" />
      <div v-else class="explorer-empty">
        <span aria-hidden="true">寻</span><h3>这组条件下，还没有照片</h3><p>换一个年份或镜头，也许会遇见另一束光。</p><button type="button" @click="apply()">查看全部照片</button>
      </div>
      <nav v-if="result.pageCount > 1" class="explorer-pagination" aria-label="全部照片分页">
        <button type="button" :disabled="result.page === 1" @click="turnPage(result.page - 1)">上一页</button>
        <span aria-live="polite">{{ result.page }} / {{ result.pageCount }}</span>
        <button type="button" :disabled="result.page === result.pageCount" @click="turnPage(result.page + 1)">下一页</button>
      </nav>
    </template>
    <div v-else class="explorer-empty"><span aria-hidden="true">光</span><h3>影像正在整理</h3><p>公开的照片会在这里相遇。</p></div>
  </section>
</template>

<style scoped>
.photo-explorer{min-width:0}.explorer-heading{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:26px}.explorer-heading h2{font-size:26px;font-weight:400;margin:0}.explorer-heading p{font-size:13px;color:var(--muted);margin:10px 0 0;line-height:1.8}.explorer-total{font-size:12px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}.explorer-filters{display:grid;grid-template-columns:minmax(120px,.7fr) minmax(0,1.3fr) minmax(0,1.5fr) minmax(110px,.7fr);gap:16px;padding:22px 0;border-block:1px solid var(--line)}.explorer-filters label{display:grid;gap:9px;min-width:0;font-size:12px;color:var(--muted)}.explorer-filters select{width:100%;min-width:0;min-height:44px;padding:10px 28px 10px 10px;font:inherit;font-size:13px;color:var(--ink);background:transparent;border:1px solid var(--line);border-radius:0;text-overflow:ellipsis}.explorer-filters select:focus-visible,.photo-explorer button:focus-visible{outline:2px solid var(--green);outline-offset:3px}.explorer-note{font-size:11px;line-height:1.8;color:var(--muted);margin:12px 0 22px}.explorer-active{display:flex;flex-wrap:wrap;gap:8px 10px;margin:0 0 24px}.explorer-active button{display:flex;align-items:center;gap:12px;border:1px solid var(--line);padding:6px 10px;min-height:36px;background:transparent;color:var(--green);font:inherit;font-size:12px;text-align:left;overflow-wrap:anywhere;cursor:pointer}.explorer-active span{font-size:16px}.explorer-active .explorer-clear{border-color:transparent;color:var(--muted);text-decoration:underline;text-underline-offset:4px}.explorer-results-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:26px 0}.explorer-results-heading h3{font-size:16px;font-weight:400;line-height:1.7;margin:0;scroll-margin-top:110px}.explorer-results-heading h3:focus{outline:none}.explorer-results-heading h3:focus-visible{outline:2px solid var(--green);outline-offset:5px}.explorer-results-heading h3>span{margin-left:6px}.explorer-results-heading small{font-size:11px;color:var(--muted);white-space:nowrap}.explorer-share{display:flex;align-items:center;gap:8px;flex-shrink:0;padding:8px 0;border:0;background:transparent;color:var(--green);font:inherit;font-size:12px;cursor:pointer}.explorer-feedback{font-size:12px;color:var(--muted);margin:0 0 20px}.explorer-empty{text-align:center;padding:46px 20px 60px;border-block:1px solid var(--line)}.explorer-empty>span{font-family:var(--font-calligraphy,serif);font-size:64px;line-height:1.3;color:var(--green);opacity:.45}.explorer-empty h3{font-size:23px;font-weight:400;margin:18px 0 12px}.explorer-empty p{font-size:13px;color:var(--muted);line-height:1.8}.explorer-empty button,.explorer-pagination button{min-height:42px;padding:9px 16px;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit;font-size:12px;cursor:pointer}.explorer-empty button{margin-top:12px}.explorer-pagination{display:flex;justify-content:center;align-items:center;gap:24px;margin-top:44px;font-size:12px;font-variant-numeric:tabular-nums}.explorer-pagination button:disabled{opacity:.4;cursor:default}
@media(max-width:760px){.explorer-filters{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px 12px}.explorer-heading h2{font-size:23px}.explorer-results-heading{align-items:start}.explorer-results-heading small{display:block}.explorer-results-heading h3{font-size:14px}.explorer-share{font-size:11px}.explorer-note{margin-bottom:18px}}
@media(max-width:380px){.explorer-heading{align-items:start}.explorer-heading h2{font-size:21px}.explorer-total{font-size:11px;padding-top:5px}.explorer-filters select{font-size:12px}.explorer-results-heading{gap:10px}.explorer-share{gap:4px}}
</style>
