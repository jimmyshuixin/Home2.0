<script setup lang="ts">
const props = withDefaults(defineProps<{ targetType?: 'guestbook' | 'creation' | 'album'; targetId?: string }>(), { targetType: 'guestbook', targetId: '' })
const api = useApi(), id = useId()
const nickname = ref(''), body = ref(''), website = ref(''), busy = ref(false), feedback = ref(''), failed = ref(false)
let requestKey = '', startedAt = 0
onMounted(() => { startedAt = Date.now() })
watch([nickname, body], () => { requestKey = ''; feedback.value = '' })
async function submit() {
  if (busy.value || !body.value.trim()) return
  busy.value = true; feedback.value = ''; failed.value = false
  requestKey ||= crypto.randomUUID()
  try {
    await api('/comments', { method: 'POST', idempotencyKey: requestKey, body: { targetType: props.targetType, targetId: props.targetType === 'guestbook' ? null : props.targetId, nickname: nickname.value.trim(), body: body.value.trim(), website: website.value, startedAt } })
    // Never add the submitted message to public lists: moderation is server-side.
    feedback.value = '已提交，审核通过后会出现在这里。'
  } catch (cause) { failed.value = true; feedback.value = cause instanceof Error ? cause.message : '提交失败，内容已保留，请稍后重试。' }
  finally { busy.value = false }
}
</script>
<template><form class="comment-form" @submit.prevent="submit"><label class="field" :for="`${id}-nickname`">昵称 <span class="muted small">（可选，不填写则为“访客”）</span><input :id="`${id}-nickname`" v-model="nickname" autocomplete="nickname" maxlength="30" placeholder="如何称呼你"></label><label class="field" :for="`${id}-body`">{{ targetType === 'guestbook' ? '想说的话' : '你的想法' }}<textarea :id="`${id}-body`" v-model="body" required maxlength="500" rows="4" :aria-describedby="`${id}-help`" placeholder="写下你想说的话……" /></label><label class="honeypot" aria-hidden="true">网站<input v-model="website" tabindex="-1" autocomplete="off"></label><div class="form-bottom" :id="`${id}-help`"><span>访客无需注册。审核通过后公开。</span><span>{{ body.length }} / 500</span></div><button class="primary" type="submit" :disabled="busy || (!failed && !!feedback)">{{ busy ? '正在提交…' : (!failed && feedback ? '已提交审核' : '提交留言') }}</button><p v-if="feedback" role="status" :class="['feedback', { error: failed }]">{{ feedback }}</p></form></template>
