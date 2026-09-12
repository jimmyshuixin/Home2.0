<script setup lang="ts">
import { fitnessDay } from '~/lib/calendar'
import { displayDate } from '~/lib/site'
const props = defineProps<{ startDate: string | null }>()
const api = useApi(), today = ref('')
const count = computed(() => fitnessDay(props.startDate, today.value))
let timer: ReturnType<typeof setTimeout> | undefined
let expiresAt = 0, busy = false
async function refresh() {
  if (!props.startDate || document.hidden || busy) return
  if (timer) clearTimeout(timer)
  if (performance.now() >= expiresAt) today.value = ''
  busy = true
  let next = 60000
  const requestedAt = performance.now()
  try {
    const { data } = await api<{ now: string; todayDate: string; timezone: string }>('/time')
    const serverNow = Date.parse(data.now), midnight = Date.parse(`${data.todayDate}T00:00:00+08:00`) + 86400000
    if (data.timezone !== 'Asia/Shanghai' || !Number.isFinite(serverNow) || !Number.isFinite(midnight)) throw new Error('Invalid time source')
    const remaining = midnight - serverNow - (performance.now() - requestedAt)
    expiresAt = performance.now() + Math.max(0, remaining)
    today.value = remaining > 0 ? data.todayDate : ''
    next = Math.min(60000, Math.max(50, remaining))
  } catch { today.value = '' }
  finally { busy = false }
  // Schedule at the trusted Shanghai midnight boundary; monotonic elapsed time
  // avoids trusting the visitor's wall clock. Expired counts disappear on refresh.
  timer = setTimeout(refresh, next)
}
onMounted(() => { void refresh(); document.addEventListener('visibilitychange', refresh); window.addEventListener('focus', refresh) })
onBeforeUnmount(() => { clearTimeout(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh) })
</script>
<template><div v-if="startDate" class="fitness-count"><p v-if="count !== null" class="day-number">健身第 <strong>{{ count }}</strong> 天</p><p class="small muted">始于 {{ displayDate(startDate) }}<br>自开始日期按日历计算，非连续打卡。</p></div></template>
