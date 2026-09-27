<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { PhotoCoordinates, PhotoMapSettings } from '@xvyin/contracts';
import { approximatePhotoCity } from '@xvyin/contracts';
import type { CircleMarker, Map as LeafletMap } from 'leaflet';
import { errorMessage } from '../api';
import { readMedia } from '../media';

const props = defineProps<{ modelValue?: PhotoMapSettings; assetId: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: PhotoMapSettings] }>();
const settings = computed<PhotoMapSettings>(() => props.modelValue ?? { visibility: 'hidden', source: 'exif' });
const visibilityLabel = computed(() => ({ hidden: '位置隐藏', city: '公开城市', exact: '公开精确位置' }[settings.value.visibility]));
const loading = ref(false), loadIssue = ref('');
const gps = ref<PhotoCoordinates>();
const latitude = ref(''), longitude = ref(''), cityName = ref('');
const mapOpen = ref(false), mapLoading = ref(false), mapIssue = ref(''), mapElement = ref<HTMLElement>();
let leaflet: typeof import('leaflet') | undefined;
let map: LeafletMap | undefined, marker: CircleMarker | undefined, mediaSequence = 0, mapSequence = 0;

function validPoint(value?: PhotoCoordinates): value is PhotoCoordinates {
  return !!value && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90 && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180;
}
const automaticCity = computed(() => gps.value ? approximatePhotoCity(gps.value) : undefined);
const manualCity = computed(() => settings.value.source === 'manual' || !!settings.value.city || !!settings.value.cityLabel);
const point = computed(() => settings.value.visibility === 'city' ? manualCity.value ? settings.value.city : automaticCity.value : settings.value.source === 'exif' ? gps.value : settings.value.coordinates);
const coordinateIssue = computed(() => {
  if (!latitude.value.trim() && !longitude.value.trim()) return '';
  const value = { latitude: Number(latitude.value), longitude: Number(longitude.value) };
  return latitude.value.trim() && longitude.value.trim() && validPoint(value) ? '' : '请填写完整坐标：纬度 −90 至 90，经度 −180 至 180。';
});
const coordinatesText = computed(() => validPoint(point.value) ? `${point.value.latitude.toFixed(6)}, ${point.value.longitude.toFixed(6)}` : '尚未指定');
function update(value: PhotoMapSettings) { emit('update:modelValue', value); }
function syncInputs(value = settings.value) {
  const selected = value.visibility === 'city' ? value.city ?? automaticCity.value : value.coordinates;
  latitude.value = selected ? String(selected.latitude) : '';
  longitude.value = selected ? String(selected.longitude) : '';
  cityName.value = value.cityLabel ?? value.city?.label ?? automaticCity.value?.label ?? '';
}
function changeVisibility(event: Event) {
  const visibility = (event.target as HTMLSelectElement).value as PhotoMapSettings['visibility'];
  const value = { ...settings.value, visibility };
  if (visibility === 'city' && !value.city && !value.cityLabel) value.source = 'exif';
  update(value); syncInputs(value); closeMap();
}
function chooseSource(source: PhotoMapSettings['source']) {
  const value = { ...settings.value, source };
  if (value.visibility === 'city') {
    if (source === 'exif') { delete value.city; delete value.cityLabel; }
    else if (!value.city && automaticCity.value) value.city = { ...automaticCity.value };
  }
  update(value); syncInputs(value); closeMap();
}
function updateCoordinates() {
  const value = { ...settings.value };
  const selected = { latitude: Number(latitude.value), longitude: Number(longitude.value) };
  const complete = !!latitude.value.trim() && !!longitude.value.trim() && validPoint(selected);
  if (value.visibility === 'city') {
    value.source = 'manual';
    value.cityLabel = cityName.value.trim();
    if (complete) value.city = { ...selected, label: cityName.value.trim() };
    else delete value.city;
  } else {
    value.source = 'manual';
    if (complete) value.coordinates = selected;
    else delete value.coordinates;
  }
  update(value);
}
function inputCoordinate(axis: 'latitude' | 'longitude', event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (axis === 'latitude') latitude.value = value;
  else longitude.value = value;
  updateCoordinates();
}
async function loadGps() {
  const sequence = ++mediaSequence;
  gps.value = undefined; loadIssue.value = ''; loading.value = false;
  if (!props.assetId) return;
  loading.value = true;
  try {
    const item = await readMedia(props.assetId);
    if (sequence === mediaSequence && validPoint(item.metadata?.gps)) gps.value = item.metadata.gps;
  } catch (error) { if (sequence === mediaSequence) loadIssue.value = errorMessage(error); }
  finally { if (sequence === mediaSequence) loading.value = false; }
}
function toggleDetails(event: Event) {
  if (!(event.target as HTMLDetailsElement).open) closeMap();
}
function closeMap() {
  mapSequence++; map?.remove(); map = undefined; marker = undefined;
  mapOpen.value = false; mapLoading.value = false; mapIssue.value = '';
}
function refreshMarker(recenter = false) {
  if (!map || !leaflet) return;
  marker?.remove(); marker = undefined;
  if (!validPoint(point.value)) return;
  const center: [number, number] = [point.value.latitude, point.value.longitude];
  marker = leaflet.circleMarker(center, { radius: 8, color: '#9f423a', weight: 2, fillColor: '#9f423a', fillOpacity: .65 }).addTo(map);
  if (recenter) map.setView(center, settings.value.visibility === 'city' ? 9 : 14);
}
async function openMap() {
  closeMap(); mapOpen.value = true; mapLoading.value = true;
  const sequence = ++mapSequence;
  try {
    const [library] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
    await nextTick();
    if (sequence !== mapSequence || !mapElement.value) return;
    leaflet = library;
    const selected = point.value;
    map = library.map(mapElement.value, { scrollWheelZoom: false, attributionControl: true }).setView(validPoint(selected) ? [selected.latitude, selected.longitude] : [35.86, 104.2], validPoint(selected) ? settings.value.visibility === 'city' ? 9 : 14 : 4);
    library.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, minZoom: 2, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
      referrerPolicy: 'strict-origin-when-cross-origin',
    }).on('tileerror', () => { if (sequence === mapSequence) mapIssue.value = '底图暂时加载失败；仍可输入坐标，或关闭后重试。'; }).addTo(map);
    map.on('click', event => {
      latitude.value = Math.max(-90, Math.min(90, event.latlng.lat)).toFixed(6);
      longitude.value = (((event.latlng.lng + 180) % 360 + 360) % 360 - 180).toFixed(6);
      updateCoordinates();
    });
    refreshMarker();
    map.invalidateSize();
  } catch { if (sequence === mapSequence) mapIssue.value = '地图暂时无法加载，请使用下方坐标输入。'; }
  finally { if (sequence === mapSequence) mapLoading.value = false; }
}
watch(() => props.assetId, () => { syncInputs(); closeMap(); void loadGps(); }, { immediate: true });
watch(gps, () => { if (!manualCity.value) syncInputs(); });
watch(point, () => refreshMarker(true), { deep: true });
onBeforeUnmount(() => { mediaSequence++; closeMap(); });
</script>

<template>
  <details class="photo-location mt16" @toggle="toggleDetails">
    <summary><span>照片地图</span><span class="location-summary">{{ loading ? '正在读取拍摄位置' : gps ? '已读取拍摄位置' : loadIssue ? '位置读取失败' : '照片无 GPS' }} · {{ visibilityLabel }}</span></summary>
    <div class="location-body">
      <p v-if="loading" class="hint" role="status">正在从照片拍摄信息读取 GPS…</p>
      <div v-else-if="loadIssue" class="hint" role="status">{{ loadIssue }} <button type="button" @click="loadGps">重新读取</button></div>
      <p v-else-if="gps" class="hint">已从照片拍摄信息读取位置：{{ gps.latitude.toFixed(6) }}, {{ gps.longitude.toFixed(6) }}。</p>
      <p v-else class="hint">照片拍摄信息中没有 GPS。照片仍可正常发布；需要位置时可手动指定。</p>
      <label class="field">访客可见的位置<select :value="settings.visibility" @change="changeVisibility"><option value="hidden">隐藏 · 不在照片地图显示</option><option value="city">城市 · 自动模糊拍摄位置</option><option value="exact">精确位置 · 显示指定的拍摄地点</option></select></label>
      <p class="hint location-hint">新照片默认从 GPS 匹配附近城市，随记录发布城市级位置。保存草稿不会公开；已有的位置选择保持不变。</p>
      <p v-if="settings.visibility === 'hidden'" class="location-note">这张照片的位置不公开；照片仍可正常展示。</p>
      <template v-else>
        <div class="location-sources" role="group" aria-label="位置来源"><button type="button" :aria-pressed="settings.visibility === 'city' ? !manualCity : settings.source === 'exif'" @click="chooseSource('exif')">照片拍摄信息（自动）</button><button type="button" :aria-pressed="settings.visibility === 'city' ? manualCity : settings.source === 'manual'" @click="chooseSource('manual')">{{ settings.visibility === 'city' ? '手动指定城市' : '手动指定位置' }}</button></div>
        <template v-if="settings.visibility === 'city'">
          <template v-if="manualCity">
            <p class="location-note">请填写城市名称，并指定该城市的参考位置。填写完整后随记录发布。</p>
            <label class="field">城市名称<input v-model="cityName" maxlength="160" placeholder="例如：合肥" @input="updateCoordinates"></label>
          </template>
          <p v-else-if="automaticCity" class="location-note">自动匹配：{{ automaticCity.label }}。访客只看到附近城市的参考位置；可切换为手动指定城市进行校正。</p>
          <p v-else-if="gps && !loading" class="location-note">暂时无法可靠匹配附近城市。照片仍可发布，地图不生成点位；可手动指定城市。</p>
        </template>
        <template v-else>
          <p v-if="settings.source === 'exif'" class="hint">随记录发布时，直接使用该照片拍摄信息中的位置；没有 GPS 时不显示地图点位。</p>
          <label class="field">地点名称，可留空<input :value="settings.label ?? ''" maxlength="160" placeholder="例如：公园湖畔" @input="update({ ...settings, label: ($event.target as HTMLInputElement).value })"></label>
        </template>
        <div class="map-actions"><button type="button" @click="mapOpen ? closeMap() : openMap()">{{ mapOpen ? '关闭地图' : '地图选点' }}</button><p class="hint">点击“地图选点”后会加载 OpenStreetMap 第三方底图。</p></div>
        <div v-if="mapOpen" class="location-map-wrap"><p class="hint">{{ settings.visibility === 'city' ? '点击地图，指定城市中心。' : '点击地图，指定拍摄地点；选点后使用手动位置。' }}</p><p v-if="mapLoading" role="status" class="hint">正在加载地图…</p><div ref="mapElement" class="location-map" role="region" aria-label="照片位置选择地图"></div><p v-if="mapIssue" class="hint map-issue" role="status">{{ mapIssue }}</p></div>
        <template v-if="settings.visibility === 'city' ? manualCity : settings.source === 'manual'">
          <div class="form-grid"><label class="field">{{ settings.visibility === 'city' ? '城市中心纬度' : '纬度' }}<input :value="latitude" type="number" min="-90" max="90" step="any" inputmode="decimal" placeholder="−90 至 90" @input="inputCoordinate('latitude', $event)"></label><label class="field">{{ settings.visibility === 'city' ? '城市中心经度' : '经度' }}<input :value="longitude" type="number" min="-180" max="180" step="any" inputmode="decimal" placeholder="−180 至 180" @input="inputCoordinate('longitude', $event)"></label></div>
          <p class="hint">坐标使用 WGS84（GPS）坐标系。</p>
          <p v-if="coordinateIssue" class="hint map-issue" role="status">{{ coordinateIssue }}</p>
        </template>
        <p class="location-preview" role="status">公开{{ settings.visibility === 'city' ? '城市参考位置' : '位置' }}：{{ settings.visibility === 'city' && cityName ? `${cityName} · ` : '' }}{{ coordinatesText }}<span v-if="settings.visibility === 'city' && manualCity && !cityName.trim()"> · 请填写城市名称</span></p>
      </template>
    </div>
  </details>
</template>

<style scoped>
.photo-location{border:1px solid var(--line);border-radius:5px}.photo-location summary{padding:14px 16px;cursor:pointer;font-size:13px}.location-summary{float:right;font-size:12px;color:var(--muted)}.location-body{display:grid;gap:16px;padding:4px 16px 18px}.location-hint{margin-top:-8px}.location-note,.location-preview{font-size:12px;line-height:1.8;padding:12px;background:var(--paper,#faf9f6);border-left:2px solid var(--line)}.location-preview{overflow-wrap:anywhere}.location-sources,.map-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.location-sources button{font-size:12px}.location-sources button[aria-pressed=true]{border-color:var(--green);color:var(--green);background:#eef0e9}.map-actions .hint{flex:1;min-width:180px}.map-actions button{flex-shrink:0}.location-map-wrap{display:grid;gap:10px;min-width:0}.location-map{height:320px;max-width:100%;z-index:0;border:1px solid var(--line);background:#ebe9dd;border-radius:4px}.map-issue{color:var(--red)}.location-body :deep(.leaflet-control-attribution){font-size:10px;line-height:1.5}.location-body :deep(.leaflet-control-zoom a){color:#27352c}@media(max-width:600px){.location-body{padding-inline:12px}.location-map{height:280px}.location-sources button{flex:1}.location-summary{float:none;margin-left:14px}.location-body .form-grid{grid-template-columns:1fr}}
</style>
