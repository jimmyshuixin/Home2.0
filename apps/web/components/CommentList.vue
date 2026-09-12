<script setup lang="ts">
type Comment = { id: string; nickname: string; body: string; createdAt?: string; publishedAt?: string }
const props = withDefaults(defineProps<{ targetType?: string; targetId?: string; compact?: boolean }>(), { targetType: 'guestbook', targetId: 'home', compact: false })
const api = useApi()
const comments = ref<Comment[]>([]), loading = ref(true), error = ref(''), cursor = ref<string | null>(null)
const enabled = ref(true), paused = ref(false), reducedMotion = ref(true)
let motion: MediaQueryList | undefined
function updateMotion() { reducedMotion.value = !!motion?.matches }
async function load(more = false) {
  loading.value = true; error.value = ''
  try {
    const params = new URLSearchParams({ targetType: props.targetType, limit: props.compact ? '12' : '20' })
    if (props.targetType !== 'guestbook') params.set('targetId', props.targetId)
    if (more && cursor.value) params.set('cursor', cursor.value)
    const response = await api<Comment[]>(`/comments?${params}`)
    comments.value = more ? [...comments.value, ...response.data] : response.data
    cursor.value = response.meta.nextCursor || null
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '留言暂时无法加载。' }
  finally { loading.value = false }
}
onMounted(() => { motion = window.matchMedia('(prefers-reduced-motion: reduce)'); updateMotion(); motion.addEventListener('change', updateMotion); void load() })
onBeforeUnmount(() => motion?.removeEventListener('change', updateMotion))
defineExpose({ load })
</script>
<template><div><div v-if="compact" class="danmaku-controls"><button class="quiet" :aria-pressed="enabled" @click="enabled = !enabled">弹幕{{ enabled ? '开' : '关' }}</button><button class="quiet" :disabled="!enabled || reducedMotion" :aria-pressed="paused" @click="paused = !paused">{{ paused ? '继续' : '暂停' }}</button></div><div :class="{ danmaku: compact, 'danmaku-animated': compact && enabled && !reducedMotion, 'danmaku-paused': paused }" aria-live="polite"><p v-if="loading && !comments.length" class="muted" role="status">正在加载留言…</p><div v-else-if="error" class="feedback error"><p>{{ error }}</p><button :disabled="loading" @click="load()">重试</button></div><p v-else-if="!comments.length" class="muted">还没有公开留言，来留第一句话。</p><ul v-else :class="compact ? 'danmaku-list' : 'comment-list'"><li v-for="(comment, i) in comments" :key="comment.id" :style="compact ? { '--track': i % 3, '--delay': `${Math.floor(i / 3) * 12 + (i % 3) * 4}s` } : undefined"><p>{{ comment.body }}</p><span class="small muted">{{ comment.nickname || '访客' }}</span></li></ul></div><button v-if="cursor && !compact" :disabled="loading" @click="load(true)">{{ loading ? '正在加载…' : '加载更多留言' }}</button></div></template>
