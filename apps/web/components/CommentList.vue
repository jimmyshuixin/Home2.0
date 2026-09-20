<script setup lang="ts">
import { createCommentLanes, advanceCommentLanes } from '~/lib/comment-lanes'
type Comment = { id: string; nickname: string; body: string; createdAt?: string; publishedAt?: string }
const props = withDefaults(defineProps<{ targetType?: string; targetId?: string; compact?: boolean; presentation?: 'stream' | 'lanes' }>(), { targetType: 'guestbook', targetId: 'home', compact: false, presentation: 'stream' })
const api = useApi()
const comments = ref<Comment[]>([]), loading = ref(true), error = ref(''), cursor = ref<string | null>(null)
const enabled = ref(true), paused = ref(false), reducedMotion = ref(true), pageVisible = ref(true)
const laneState = ref(createCommentLanes<Comment>([]))
const tracks = computed(() => laneState.value.tracks)
const lanes = computed(() => props.compact && props.presentation === 'lanes')
const animated = computed(() => props.compact && enabled.value && !reducedMotion.value)
const shownComments = computed(() => lanes.value && animated.value ? tracks.value.map(track => track.comment) : comments.value)
let motion: MediaQueryList | undefined
let rotation: ReturnType<typeof setInterval> | undefined

function updateMotion() { reducedMotion.value = !!motion?.matches }
function updateVisibility() { pageVisible.value = !document.hidden }
function stopRotation() { clearInterval(rotation); rotation = undefined }
function startRotation() {
  stopRotation()
  if (!lanes.value || !animated.value || paused.value || !pageVisible.value || comments.value.length <= 3) return
  rotation = setInterval(() => {
    // Keep three real comments visible immediately; replace one lane at a time.
    laneState.value = advanceCommentLanes(comments.value, laneState.value)
  }, 8000)
}
watch([animated, paused, pageVisible, () => comments.value.length], startRotation)

async function load(more = false) {
  loading.value = true; error.value = ''
  try {
    const params = new URLSearchParams({ targetType: props.targetType, limit: props.compact ? '12' : '20' })
    if (props.targetType !== 'guestbook') params.set('targetId', props.targetId)
    if (more && cursor.value) params.set('cursor', cursor.value)
    const response = await api<Comment[]>(`/comments?${params}`)
    comments.value = more ? [...comments.value, ...response.data] : response.data
    laneState.value = createCommentLanes(comments.value)
    cursor.value = response.meta.nextCursor || null
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '留言暂时无法加载。' }
  finally { loading.value = false }
}
onMounted(() => {
  motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  updateMotion(); updateVisibility()
  motion.addEventListener('change', updateMotion)
  document.addEventListener('visibilitychange', updateVisibility)
  void load()
})
onBeforeUnmount(() => {
  stopRotation()
  motion?.removeEventListener('change', updateMotion)
  document.removeEventListener('visibilitychange', updateVisibility)
})

defineExpose({ load })
</script>

<template>
  <div class="comments-stream">
    <div v-if="compact" class="danmaku-controls" aria-label="留言动态控制">
      <button class="quiet" :aria-pressed="enabled" @click="enabled = !enabled">弹幕{{ enabled ? '开' : '关' }}</button>
      <button class="quiet" :disabled="!enabled || reducedMotion" :aria-pressed="paused" @click="paused = !paused">{{ paused ? '继续' : '暂停' }}</button>
    </div>
    <div :class="{ danmaku: compact, 'danmaku-animated': animated, 'danmaku-paused': paused, 'danmaku-lanes': lanes }" :aria-live="animated && !paused ? 'off' : 'polite'">
      <p v-if="loading && !comments.length" class="muted" role="status">正在加载留言…</p>
      <div v-else-if="error" class="feedback error" role="status"><p>{{ error }}</p><button :disabled="loading" @click="load()">重试</button></div>
      <p v-else-if="!comments.length" class="muted" role="status">还没有公开留言，来留第一句话。</p>
      <ul v-else :class="compact ? 'danmaku-list' : 'comment-list'">
        <li v-for="(comment, i) in shownComments" :key="comment.id" :data-entering="lanes && animated && tracks[i]?.entering ? 'true' : undefined" :style="compact && !lanes ? { '--track': i % 3, '--delay': `${Math.floor(i / 3) * 12 + (i % 3) * 4}s` } : undefined">
          <p>{{ comment.body }}</p><span class="small muted">{{ comment.nickname || '访客' }}</span>
        </li>
      </ul>
    </div>
    <button v-if="cursor && !compact" :disabled="loading" @click="load(true)">{{ loading ? '正在加载…' : '加载更多留言' }}</button>
  </div>
</template>
