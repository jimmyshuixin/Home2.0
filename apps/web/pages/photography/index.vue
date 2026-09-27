<script setup lang="ts">
import { site, assetVariant, assetSrcSet, ordered } from '~/lib/site'
const PhotoMap = defineAsyncComponent({
  loader: () => import('~/components/PhotoMap.vue'), delay: 150, timeout: 20000,
  loadingComponent: { render: () => h('p', { role: 'status' }, '正在展开地图…') },
  errorComponent: { render: () => h('div', { role: 'status' }, [h('p', '地图暂时无法加载，相册仍可浏览。'), h('button', { type: 'button', onClick: () => window.location.reload() }, '刷新后重试')]) },
})
const route = useRoute(), router = useRouter(), view = ref<'albums' | 'map'>('albums')
onMounted(() => { view.value = route.query.view === 'map' ? 'map' : 'albums' })
watch(() => route.query.view, value => { view.value = value === 'map' ? 'map' : 'albums' })
function changeView(next: 'albums' | 'map') { view.value = next; router.replace({ query: { ...route.query, view: next === 'map' ? 'map' : undefined } }) }
const albums = ordered(site.albums).map((album) => ({
  ...album,
  cover: assetVariant(album.coverAssetId || album.photos[0]?.assetId)
}))
useSeoMeta({ title: '摄影 · 虚宁', description: '用镜头，收藏片刻。' })
</script>
<template>
  <section class="page-heading">
    <h1>用镜头，收藏片刻<span class="dot" aria-hidden="true" /></h1>
    <p>一些光线，一些经过的地方。</p>
  </section>
  <div class="photography-views" role="group" aria-label="摄影浏览方式">
    <button type="button" :aria-pressed="view === 'albums'" aria-controls="photography-content" @click="changeView('albums')">相册</button>
    <button type="button" :aria-pressed="view === 'map'" aria-controls="photography-content" @click="changeView('map')">地图</button>
  </div>
  <div id="photography-content">
  <PhotoMap v-if="view === 'map'" :albums="albums" />
  <div v-else-if="albums.length" class="album-list">
    <article v-for="album in albums" :key="album.id" class="album-card">
      <NuxtLink :to="`/photography/${album.slug}`">
        <span v-if="album.cover" class="album-cover" :style="{ '--album-cover-ratio': `${album.cover.width || 3} / ${album.cover.height || 2}` }">
          <img
            :src="album.cover.url"
            :srcset="assetSrcSet(album.coverAssetId || album.photos[0]?.assetId)"
            sizes="(max-width: 760px) calc(100vw - 66px), 540px"
            decoding="async"
            :alt="album.title"
            :width="album.cover.width"
            :height="album.cover.height"
            loading="lazy"
          >
        </span>
        <h2>{{ album.title }}</h2>
      </NuxtLink>
      <p v-if="album.description">{{ album.description }}</p>
      <NuxtLink class="text-link" :to="`/photography/${album.slug}`">打开这个系列<SiteIcon name="arrow" :size="18" /></NuxtLink>
    </article>
  </div>
  <div v-else class="empty-state">
    <h2>还没有公开摄影系列</h2>
    <p>影像正在整理，准备好后会出现在这里。</p>
    <NuxtLink class="text-link" to="/creations">先看看创作<SiteIcon name="arrow" /></NuxtLink>
  </div>
  </div>
</template>
<style scoped>
.photography-views{display:flex;gap:30px;align-items:center;margin:0 0 34px;border-bottom:1px solid var(--line)}.photography-views button{position:relative;background:transparent;border:0;padding:0 2px 15px;color:var(--muted);font:inherit;font-size:16px;cursor:pointer;min-width:48px}.photography-views button[aria-pressed=true]{color:var(--green)}.photography-views button[aria-pressed=true]::after{content:'';position:absolute;bottom:-1px;left:0;right:0;height:2px;background:var(--red,#9d4336)}.photography-views button:focus-visible{outline:2px solid var(--green);outline-offset:5px}@media(max-width:600px){.photography-views{margin-bottom:26px;gap:24px}}
</style>
