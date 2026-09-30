<script setup lang="ts">
import type { TopicMember } from '@xvyin/contracts'
import { site } from '~/lib/site'
import { topicMemberships } from '~/lib/topics'
const props = defineProps<{ member: TopicMember }>()
const memberships = computed(() => topicMemberships(props.member, site))
</script>

<template>
  <section v-if="memberships.length" class="topic-backlinks" aria-label="所属专题">
    <h2>收录在专题</h2>
    <div v-for="membership in memberships" :key="membership.topic.id" class="topic-membership">
      <div class="topic-position"><NuxtLink :to="`/topics/${membership.topic.slug}`">{{ membership.topic.title }}<span aria-hidden="true"> ↗</span></NuxtLink><span>第 {{ membership.position }} / {{ membership.total }} 项</span></div>
      <nav v-if="membership.previous || membership.next" class="topic-neighbours" :aria-label="`${membership.topic.title}阅读顺序`">
        <NuxtLink v-if="membership.previous" :to="membership.previous.href"><small>← 上一项 · {{ membership.previous.label }}</small><span>{{ membership.previous.title }}</span></NuxtLink>
        <NuxtLink v-if="membership.next" class="topic-next" :to="membership.next.href"><small>下一项 · {{ membership.next.label }} →</small><span>{{ membership.next.title }}</span></NuxtLink>
      </nav>
    </div>
  </section>
</template>

<style scoped>
.topic-backlinks{margin:48px 0;padding:28px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.topic-backlinks h2{font-size:18px;margin:0 0 20px}.topic-membership+.topic-membership{margin-top:24px;padding-top:24px;border-top:1px solid var(--line)}.topic-position{display:flex;gap:16px;align-items:baseline;justify-content:space-between}.topic-position>a{font-size:20px;color:var(--green);text-decoration:none}.topic-position>span{color:var(--muted);font-size:12px;white-space:nowrap}.topic-neighbours{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;margin-top:20px}.topic-neighbours a{display:flex;flex-direction:column;gap:6px;min-height:44px;text-decoration:none;overflow-wrap:anywhere}.topic-neighbours small{font-size:11px;color:var(--muted)}.topic-next{grid-column:2;text-align:right}@media(max-width:520px){.topic-position{align-items:flex-start;flex-direction:column;gap:6px}.topic-neighbours{gap:16px}.topic-position>a{font-size:18px}}
</style>
