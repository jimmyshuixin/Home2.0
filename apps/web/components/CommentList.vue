<script setup lang="ts">
import { createCommentLanes, measureCommentLoop, type CommentLoop } from '~/lib/comment-lanes'
type Comment = { id: string; nickname: string; body: string; createdAt?: string; publishedAt?: string }
const props = withDefaults(defineProps<{ targetType?: string; targetId?: string; compact?: boolean; presentation?: 'stream' | 'lanes' }>(), { targetType: 'guestbook', targetId: 'home', compact: false, presentation: 'stream' })
const api = useApi()
const comments = ref<Comment[]>([]), loading = ref(true), error = ref(''), cursor = ref<string | null>(null)
const enabled = ref(true), paused = ref(false), reducedMotion = ref(true), pageVisible = ref(true)
const viewport = ref<HTMLElement>()
const laneComments = computed(() => createCommentLanes(comments.value))
const laneLoops = ref<CommentLoop[]>([])
const lanes = computed(() => props.compact && props.presentation === 'lanes')
const animated = computed(() => props.compact && enabled.value && !reducedMotion.value)
let motion: MediaQueryList | undefined
let resizeObserver: ResizeObserver | undefined
let disposed = false

function updateMotion() { reducedMotion.value = !!motion?.matches }
function updateVisibility() { pageVisible.value = !document.hidden }
function measureLanes() {
  if (!viewport.value || !lanes.value || !animated.value) return
  const viewportWidth = viewport.value.clientWidth
  const measured = Array.from(viewport.value.querySelectorAll<HTMLElement>('[data-lane-seed]'), element =>
    measureCommentLoop(viewportWidth, element.getBoundingClientRect().width))
  if (measured.some((loop, index) => loop.cycleWidth !== laneLoops.value[index]?.cycleWidth || loop.repetitions !== laneLoops.value[index]?.repetitions) || measured.length !== laneLoops.value.length) {
    laneLoops.value = measured
  }
}
async function observeLanes() {
  await nextTick()
  if (disposed) return
  resizeObserver?.disconnect()
  if (!viewport.value || !lanes.value || !animated.value) return
  measureLanes()
  resizeObserver ||= new ResizeObserver(measureLanes)
  resizeObserver.observe(viewport.value)
  for (const element of viewport.value.querySelectorAll<HTMLElement>('[data-lane-seed]')) resizeObserver.observe(element)
}
watch([animated, lanes, comments], () => { void observeLanes() })

async function load(more = false) {
  loading.value = true; error.value = ''
  try {
    const params = new URLSearchParams({ targetType: props.targetType, limit: props.compact ? '12' : '20' })
    if (props.targetType !== 'guestbook') params.set('targetId', props.targetId)
    if (more && cursor.value) params.set('cursor', cursor.value)
    const response = await api<Comment[]>(`/comments?${params}`)
    comments.value = more ? [...comments.value, ...response.data] : response.data
    laneLoops.value = []
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
  disposed = true
  resizeObserver?.disconnect()
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
    <div ref="viewport" :class="{ danmaku: compact, 'danmaku-animated': animated, 'danmaku-paused': paused || !pageVisible, 'danmaku-lanes': lanes }" :aria-live="animated && !paused ? 'off' : 'polite'">
      <p v-if="loading && !comments.length" class="muted" role="status">正在加载留言…</p>
      <div v-else-if="error" class="feedback error" role="status"><p>{{ error }}</p><button :disabled="loading" @click="load()">重试</button></div>
      <p v-else-if="!comments.length" class="muted" role="status">还没有公开留言，来留第一句话。</p>
      <ul v-else-if="lanes && animated" class="danmaku-lane-list" aria-label="公开留言">
        <li v-for="(lane, laneIndex) in laneComments" :key="laneIndex" class="danmaku-lane">
          <div class="danmaku-track" :class="{ 'is-ready': laneLoops[laneIndex]?.cycleWidth }" :style="{ '--lane-duration': `${laneLoops[laneIndex]?.durationSeconds || 30}s` }">
            <div v-for="copy in 2" :key="copy" class="danmaku-cycle" :aria-hidden="copy === 2 ? 'true' : undefined">
              <div v-for="repetition in laneLoops[laneIndex]?.repetitions || 1" :key="repetition" class="danmaku-sequence" :data-lane-seed="copy === 1 && repetition === 1 ? laneIndex : undefined" :aria-hidden="repetition > 1 ? 'true' : undefined">
                <span v-for="comment in lane" :key="comment.id" class="danmaku-message"><span class="danmaku-body">{{ comment.body }}</span><span class="small muted">{{ comment.nickname || '访客' }}</span></span>
              </div>
            </div>
          </div>
        </li>
      </ul>
      <ul v-else :class="compact ? 'danmaku-list' : 'comment-list'">
        <li v-for="(comment, i) in comments" :key="comment.id" :style="compact && !lanes ? { '--track': i % 3, '--delay': `${Math.floor(i / 3) * 12 + (i % 3) * 4}s` } : undefined">
          <p>{{ comment.body }}</p><span class="small muted">{{ comment.nickname || '访客' }}</span>
        </li>
      </ul>
    </div>
    <button v-if="cursor && !compact" :disabled="loading" @click="load(true)">{{ loading ? '正在加载…' : '加载更多留言' }}</button>
  </div>
</template>
