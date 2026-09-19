<script setup lang="ts">
import { visitorId, targetKey, type EngagementTarget } from '~/lib/engagement'
const props = withDefaults(defineProps<{ target: EngagementTarget; label?: string; loadCount?: boolean }>(), { loadCount: true })
const api = useApi(), element = ref<HTMLElement>(), count = ref<number | null>(null), liked = ref(false), busy = ref(false), feedback = ref('')
let observer: IntersectionObserver | undefined, loaded = false, generation = 0
const stateKey = (target: EngagementTarget) => `xvyin-like/${visitorId()}/${targetKey(target)}`
function restoreState() { try { liked.value = localStorage.getItem(stateKey(props.target)) === '1' } catch { liked.value = false } }
async function load() {
  if (loaded) return
  loaded = true
  const current = ++generation
  const query = new URLSearchParams({ ...props.target })
  try { const result = await api<{ count: number }>(`/likes?${query}`); if (current === generation) count.value = result.data.count } catch { loaded = false }
}
async function toggle() {
  if (busy.value) return
  busy.value = true; feedback.value = ''; const current = ++generation
  const requestedTarget = { ...props.target }, requestedKey = targetKey(requestedTarget)
  try {
    const result = await api<{ count: number; liked: boolean }>('/likes', { method: 'PUT', body: { ...requestedTarget, visitorId: visitorId(), liked: !liked.value } })
    try { if (result.data.liked) localStorage.setItem(stateKey(requestedTarget), '1'); else localStorage.removeItem(stateKey(requestedTarget)) } catch { /* Server count is still confirmed; persistence is optional. */ }
    if (current === generation) { count.value = result.data.count; liked.value = result.data.liked }
    window.dispatchEvent(new CustomEvent('xvyin-like-changed', { detail: { key: requestedKey, ...result.data } }))
  } catch (error) { if (current === generation) feedback.value = error instanceof Error ? error.message : '暂时无法点赞，请稍后重试。' }
  finally { if (current === generation) busy.value = false }
}
function changed(event: Event) { const detail = (event as CustomEvent).detail; if (detail?.key === targetKey(props.target)) { count.value = detail.count; liked.value = detail.liked } }
onMounted(() => {
  restoreState()
  window.addEventListener('xvyin-like-changed', changed)
  if (props.loadCount) { if ('IntersectionObserver' in window && element.value) { observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); void load() } }); observer.observe(element.value) } else void load() }
})
watch(() => targetKey(props.target), () => { generation++; busy.value = false; loaded = false; count.value = null; restoreState(); feedback.value = ''; if (props.loadCount) void load() })
onBeforeUnmount(() => { observer?.disconnect(); window.removeEventListener('xvyin-like-changed', changed); generation++ })
</script>
<template><span ref="element" class="like-control"><button class="like-button" type="button" :class="{liked}" :aria-pressed="liked" :aria-label="`${liked ? '取消点赞' : '点赞'}${label || ''}`" :disabled="busy" @click="toggle"><svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" :fill="liked ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.5"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg><span>{{ liked ? '已赞' : '喜欢' }}</span><span v-if="count !== null" class="like-count">{{ count }}</span></button><span v-if="feedback" class="like-feedback" role="status">{{ feedback }}</span></span></template>
<style scoped>.like-control{display:inline-flex;flex-wrap:wrap;align-items:center;gap:8px;max-width:100%;vertical-align:middle}.like-button{display:inline-flex;align-items:center;gap:8px;min-height:40px;padding:8px 13px;border:1px solid var(--line);border-radius:24px;background:transparent;color:var(--muted);font:inherit;font-size:13px;white-space:nowrap}.like-button.liked{color:var(--red,#98483c);border-color:currentColor}.like-count{font-variant-numeric:tabular-nums}.like-feedback{font-size:12px;max-width:28rem;color:var(--muted);line-height:1.6}</style>
