<script setup lang="ts">
const api = useApi(), id = useId()
const name = ref(''), email = ref(''), message = ref(''), website = ref(''), busy = ref(false), feedback = ref(''), failed = ref(false)
let requestKey = '', startedAt = 0
onMounted(() => { startedAt = Date.now() })
watch([name, email, message], () => { requestKey = ''; feedback.value = '' })
async function submit() {
  if (busy.value) return
  busy.value = true; failed.value = false; feedback.value = ''; requestKey ||= crypto.randomUUID()
  try { await api('/contact', { method: 'POST', idempotencyKey: requestKey, body: { nickname: name.value.trim(), email: email.value.trim(), message: message.value.trim(), website: website.value, startedAt } }); feedback.value = '私信已收到，谢谢你的来信。它不会出现在公开留言中。' }
  catch (cause) { failed.value = true; feedback.value = cause instanceof Error ? cause.message : '暂时无法发送，内容已保留，请稍后重试。' }
  finally { busy.value = false }
}
</script>
<template><form @submit.prevent="submit"><label class="field" :for="`${id}-name`">称呼<input :id="`${id}-name`" v-model="name" maxlength="30" autocomplete="name" required></label><label class="field" :for="`${id}-email`">你的邮箱<input :id="`${id}-email`" v-model="email" type="email" maxlength="254" autocomplete="email" required><span class="small muted">仅用于回复，不会公开。</span></label><label class="field" :for="`${id}-message`">想聊些什么<textarea :id="`${id}-message`" v-model="message" required maxlength="5000" rows="5" /></label><label class="honeypot" aria-hidden="true">网站<input v-model="website" tabindex="-1" autocomplete="off"></label><button class="primary" :disabled="busy || (!failed && !!feedback)" type="submit">{{ busy ? '正在发送…' : (!failed && feedback ? '已发送' : '发送私信') }}<SiteIcon name="arrow" /></button><p v-if="feedback" :class="['feedback', { error: failed }]" role="status">{{ feedback }}</p></form></template>
