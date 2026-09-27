<script setup lang="ts">
import type * as Leaflet from 'leaflet'
import type { MapAlbum, PhotoMapEntry } from '~/lib/photo-map'
import { photoMapEntries } from '~/lib/photo-map'
import { assetVariant, displayDate } from '~/lib/site'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'

const props = defineProps<{ albums: MapAlbum[] }>()
const entries = computed(() => photoMapEntries(props.albums))
const albumFilter = ref(''), selectedKey = ref(''), page = ref(1), pageSize = 12
const visible = computed(() => entries.value.filter(entry => !albumFilter.value || entry.album.id === albumFilter.value))
const selected = computed(() => visible.value.find(entry => entry.key === selectedKey.value))
const pageCount = computed(() => Math.max(1, Math.ceil(visible.value.length / pageSize)))
const pageEntries = computed(() => visible.value.slice((page.value - 1) * pageSize, page.value * pageSize))
const availableAlbums = computed(() => props.albums.filter(album => entries.value.some(entry => entry.album.id === album.id)))
const canvas = ref<HTMLElement>(), detail = ref<HTMLElement>()
const loading = ref(false), failed = ref(false), tileFailed = ref(false)
let map: Leaflet.Map | undefined, clusters: Leaflet.MarkerClusterGroup | undefined, L: typeof Leaflet | undefined
let disposed = false, reducedMotion = true
const markers = new Map<string, Leaflet.Marker>()

function select(entry: PhotoMapEntry, fromMap = false) {
  selectedKey.value = entry.key
  page.value = Math.floor(visible.value.findIndex(item => item.key === entry.key) / pageSize) + 1
  const marker = markers.get(entry.key)
  if (!fromMap && map && marker && clusters) clusters.zoomToShowLayer(marker, () => {})
  if (fromMap) nextTick(() => { detail.value?.focus({ preventScroll: true }); detail.value?.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' }) })
}
function fit() {
  if (!map || !L || !visible.value.length) return
  map.fitBounds(L.latLngBounds(visible.value.map(entry => [entry.location.latitude, entry.location.longitude])), { padding: [36, 36], maxZoom: visible.value.every(entry => entry.location.precision === 'city') ? 9 : 13, animate: !reducedMotion })
}
function draw() {
  if (!L || !map || !clusters) return
  clusters.clearLayers(); markers.clear()
  const items = visible.value.map(entry => {
    const marker = L!.marker([entry.location.latitude, entry.location.longitude], {
      icon: L!.divIcon({ className: 'photo-map-pin', html: '<span aria-hidden="true"></span>', iconSize: [30, 30], iconAnchor: [15, 15] }),
      title: `${entry.location.label || (entry.location.precision === 'city' ? '城市位置' : '拍摄地点')} · ${entry.photo.alt}`,
      alt: entry.photo.alt, keyboard: true,
    }).on('click', () => select(entry, true))
    markers.set(entry.key, marker)
    return marker
  })
  clusters.addLayers(items); fit()
}
async function start() {
  if (!canvas.value || map || loading.value || !entries.value.length) return
  loading.value = true; failed.value = false; tileFailed.value = false
  try {
    const leaflet = await import('leaflet')
    L = leaflet.default || leaflet
    await import('leaflet.markercluster')
    if (disposed || !canvas.value) return
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    map = L.map(canvas.value, { center: [30, 105], zoom: 3, scrollWheelZoom: false, zoomAnimation: !reducedMotion, fadeAnimation: !reducedMotion, markerZoomAnimation: !reducedMotion })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      minZoom: 2, maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    }).on('tileerror', () => { tileFailed.value = true }).addTo(map)
    clusters = L.markerClusterGroup({
      showCoverageOnHover: false, animate: !reducedMotion, maxClusterRadius: 46, spiderfyOnMaxZoom: true,
      iconCreateFunction: cluster => L!.divIcon({ className: 'photo-map-cluster', html: `<span>${cluster.getChildCount()}</span>`, iconSize: [42, 42] }),
    })
    map.addLayer(clusters); draw()
  } catch {
    map?.remove(); map = undefined; failed.value = true
  } finally { loading.value = false }
}
watch(albumFilter, () => { page.value = 1; selectedKey.value = ''; draw() })
onMounted(start)
onBeforeUnmount(() => { disposed = true; map?.remove(); markers.clear() })
</script>

<template>
  <section class="photo-map-view" aria-label="照片地图">
    <div v-if="!entries.length" class="map-empty">
      <span class="map-empty-mark" aria-hidden="true">迹</span>
      <h2>有些片刻，还未标上地点</h2>
      <p>公开拍摄地点后，照片会在这里留下足迹。所有照片仍可在相册中浏览。</p>
    </div>
    <template v-else>
      <div class="map-toolbar">
        <div><h2>光影所至</h2><p>{{ visible.length }} 张照片的公开地点<span v-if="albumFilter"> · {{ entries.length }} 张照片已入地图</span></p></div>
        <label>选择系列<select v-model="albumFilter"><option value="">全部系列</option><option v-for="album in availableAlbums" :key="album.id" :value="album.id">{{ album.title }}</option></select></label>
      </div>
      <div class="map-frame">
        <div ref="canvas" class="map-canvas" aria-label="拍摄地点，可用方向键移动、加减键缩放" />
        <p v-if="loading" class="map-message" role="status">正在展开地图…</p>
        <div v-if="failed" class="map-message" role="status"><p>地图暂时无法展开，下方仍可浏览照片。</p><button type="button" @click="start">重新加载地图</button></div>
        <button v-if="!loading && !failed" type="button" class="map-fit" @click="fit">查看全部地点</button>
      </div>
      <p class="map-note">地图仅展示作者选择公开的位置；城市标记代表城市中心。底图由 OpenStreetMap 提供。</p>
      <p v-if="tileFailed && !failed" class="map-note" role="status">部分底图未能加载，照片列表和已显示的标记仍可使用。</p>
      <div class="map-bottom" :class="{ 'has-selection': selected }">
        <div class="map-results">
          <h3>沿着地点看照片</h3>
          <div class="map-photo-list">
            <button v-for="entry in pageEntries" :key="entry.key" type="button" class="map-photo" :class="{ selected: selectedKey === entry.key }" :aria-pressed="selectedKey === entry.key" @click="select(entry)">
              <img v-if="assetVariant(entry.photo.assetId, 'thumb')" :src="assetVariant(entry.photo.assetId, 'thumb')?.url" :alt="entry.photo.alt" loading="lazy" width="84" height="66">
              <span><strong>{{ entry.location.label || (entry.location.precision === 'city' ? '城市位置' : '拍摄地点') }}</strong><span>{{ entry.album.title }}</span><time v-if="entry.photo.photoDate" :datetime="entry.photo.photoDate">{{ displayDate(entry.photo.photoDate) }}</time></span>
            </button>
          </div>
          <nav v-if="pageCount > 1" class="map-pagination" aria-label="地图照片分页"><button type="button" :disabled="page === 1" @click="page--">上一页</button><span>{{ page }} / {{ pageCount }}</span><button type="button" :disabled="page === pageCount" @click="page++">下一页</button></nav>
        </div>
        <section v-if="selected" ref="detail" class="map-detail" tabindex="-1" aria-label="选中的照片">
          <div class="map-detail-heading"><h3>{{ selected.location.label || '在此留下的片刻' }}</h3><button type="button" aria-label="关闭选中的照片" @click="selectedKey = ''">×</button></div>
          <p class="map-note">{{ selected.location.precision === 'city' ? '展示城市中心' : '展示拍摄位置' }}</p>
          <PhotoGallery :key="selected.key" :photos="[selected.photo]" :album-id="selected.album.id" layout="continuous" />
          <NuxtLink class="text-link map-album-link" :to="`/photography/${selected.album.slug}`">走进「{{ selected.album.title }}」<SiteIcon name="arrow" :size="18" /></NuxtLink>
        </section>
      </div>
    </template>
  </section>
</template>

<style scoped>
.photo-map-view{min-width:0}.map-toolbar{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:22px}.map-toolbar h2{font-size:26px;font-weight:400;margin:0}.map-toolbar p,.map-note{font-size:12px;color:var(--muted);line-height:1.8}.map-toolbar p{margin:8px 0 0}.map-toolbar label{display:grid;gap:8px;font-size:12px;color:var(--muted)}.map-toolbar select{min-width:180px;max-width:100%;padding:9px 30px 9px 12px;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit}.map-frame{position:relative;isolation:isolate;border:1px solid var(--line);background:#e6e7dd}.map-canvas{height:clamp(360px,58vh,620px);width:100%;font-family:inherit}.map-message{position:absolute;inset:0;display:grid;place-content:center;text-align:center;padding:24px;z-index:1000;background:var(--paper,#f7f3e9);font-size:14px}.map-message button{margin:14px auto 0}.map-fit{position:absolute;right:12px;top:12px;z-index:500;background:var(--paper,#f7f3e9);border:1px solid var(--line);font:inherit;font-size:12px;padding:10px 14px;color:var(--ink);cursor:pointer}.map-note{margin:10px 0 20px}.map-bottom{display:grid;gap:36px;margin-top:32px}.map-bottom.has-selection{grid-template-columns:minmax(230px,.85fr) minmax(0,1.4fr)}.map-bottom h3{font-weight:400;font-size:19px;margin:0 0 18px}.map-photo-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 20px}.has-selection .map-photo-list{grid-template-columns:minmax(0,1fr)}.map-photo{display:flex;gap:14px;align-items:center;min-width:0;text-align:left;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--ink);padding:15px 0;font:inherit;cursor:pointer}.map-photo.selected{box-shadow:inset 3px 0 var(--green);padding-left:12px}.map-photo>img{width:84px;height:66px;object-fit:cover;flex-shrink:0}.map-photo>span{display:grid;gap:5px;min-width:0}.map-photo strong{font-size:14px;font-weight:400;overflow-wrap:anywhere}.map-photo span span,.map-photo time{font-size:11px;color:var(--muted)}.map-pagination{display:flex;align-items:center;justify-content:center;gap:20px;font-size:12px;margin-top:24px}.map-pagination button,.map-detail-heading button{background:transparent;color:var(--ink);border:1px solid var(--line);padding:9px 12px;font:inherit;cursor:pointer}.map-pagination button:disabled{opacity:.4;cursor:default}.map-detail{min-width:0;border-left:1px solid var(--line);padding-left:32px;scroll-margin-top:100px}.map-detail-heading{display:flex;gap:16px;align-items:center;justify-content:space-between}.map-detail-heading h3{margin:0}.map-detail-heading button{font-size:22px;border:0;padding:4px 10px}.map-album-link{margin-top:24px}.map-empty{padding:50px 20px 70px;text-align:center;border-block:1px solid var(--line)}.map-empty-mark{display:block;font-family:var(--font-calligraphy,serif);font-size:72px;line-height:1.4;color:var(--green);opacity:.45}.map-empty h2{font-size:24px;font-weight:400;margin:14px 0}.map-empty p{font-size:14px;color:var(--muted);line-height:1.9;max-width:30em;margin:auto}.photo-map-view :deep(.photo-map-pin){display:grid;place-items:center}.photo-map-view :deep(.photo-map-pin>span){width:16px;height:16px;background:var(--green,#425749);border:3px solid #f7f3e9;border-radius:50%;box-shadow:0 1px 6px #0005}.photo-map-view :deep(.photo-map-cluster){display:grid;place-items:center;border-radius:50%;background:#42574928;border:1px solid #42574950;color:#fff}.photo-map-view :deep(.photo-map-cluster>span){display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#425749;font-size:12px}.photo-map-view :deep(.leaflet-control-attribution){font-size:10px}.photo-map-view :deep(.leaflet-control-attribution a){color:#345b43}.photo-map-view :deep(.leaflet-control-zoom a){color:#345b43}
@media(max-width:760px){.map-toolbar{align-items:start}.map-toolbar h2{font-size:22px}.map-toolbar select{min-width:0;width:132px}.map-toolbar p{max-width:17em}.map-canvas{height:410px;max-height:65svh}.map-photo-list{grid-template-columns:repeat(2,minmax(0,1fr))}.map-bottom.has-selection{grid-template-columns:minmax(0,1fr)}.map-detail{grid-row:1;border-left:0;padding-left:0;padding-bottom:28px;border-bottom:1px solid var(--line)}.map-empty{padding-inline:12px}.map-empty h2{font-size:21px}}
@media(max-width:420px){.map-photo-list{grid-template-columns:minmax(0,1fr)}.map-toolbar{gap:12px}.map-toolbar select{width:116px}.map-fit{padding:9px;font-size:11px}}
@media(prefers-reduced-motion:reduce){.photo-map-view :deep(*){scroll-behavior:auto!important;transition:none!important;animation:none!important}}
</style>
