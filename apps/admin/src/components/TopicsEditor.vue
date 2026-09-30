<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { TOPIC_LIMITS, type Topic, type TopicMember } from '@xvyin/contracts';
import { api, errorMessage, visibilityLabel, type DraftRecord } from '../api';

const props = defineProps<{ modelValue?: Topic[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: Topic[]] }>();
const topics = computed(() => props.modelValue || []);
type Choice = DraftRecord<{ title?: string }> & { collection: TopicMember['collection'] };
const choices = ref<Choice[]>([]), loaded = ref(false), loading = ref(false), issue = ref('');
const selectedTopic = ref(''), query = ref('');
const cursors = ref<Partial<Record<TopicMember['collection'], string>>>({});
const controller = new AbortController();
onBeforeUnmount(() => controller.abort());
const currentTopic = computed(() => topics.value.find(topic => topic.id === selectedTopic.value));
const available = computed(() => choices.value.filter(item =>
  !currentTopic.value?.members.some(member => member.id === item.id && member.collection === item.collection)
  && `${item.draft.title || ''} ${item.id}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const hasMore = computed(() => Boolean(cursors.value.creations || cursors.value.albums));
function update(index: number, value: Partial<Topic>) {
  emit('update:modelValue', topics.value.map((topic, position) => position === index ? { ...topic, ...value } : topic));
}
function addTopic() {
  if (topics.value.length >= TOPIC_LIMITS.topics) return;
  const topic: Topic = { id: crypto.randomUUID(), slug: '', title: '', intro: '', enabled: false, members: [] };
  emit('update:modelValue', [...topics.value, topic]);
}
function move(index: number, offset: number) {
  const next = [...topics.value], to = index + offset;
  if (to < 0 || to >= next.length) return;
  const [topic] = next.splice(index, 1); if (topic) next.splice(to, 0, topic);
  emit('update:modelValue', next);
}
function remove(index: number) {
  if (!window.confirm('移除这个专题？专题中的创作与相册会保留。')) return;
  emit('update:modelValue', topics.value.filter((_, position) => position !== index));
}
function moveMember(index: number, position: number, offset: number) {
  const members = [...topics.value[index]!.members], to = position + offset;
  if (to < 0 || to >= members.length) return;
  const [member] = members.splice(position, 1); if (member) members.splice(to, 0, member);
  update(index, { members });
}
function memberLabel(member: TopicMember) {
  const record = choices.value.find(item => item.collection === member.collection && item.id === member.id);
  return record ? `${record.draft.title || '未命名'} · ${visibilityLabel(record.visibility)}` : `已选${member.collection === 'albums' ? '相册' : '创作'} · ${member.id}`;
}
async function loadMore() {
  if (loading.value) return;
  loading.value = true; issue.value = '';
  try {
    for (const collection of ['creations', 'albums'] as const) {
      const cursor = cursors.value[collection];
      if (loaded.value && !cursor) continue;
      const response = await api.request<DraftRecord<{ title?: string }>[]>(`/admin/${collection}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: controller.signal });
      const known = new Set(choices.value.filter(item => item.collection === collection).map(item => item.id));
      choices.value.push(...response.data.filter(item => !known.has(item.id)).map(item => ({ ...item, collection })));
      cursors.value[collection] = response.meta.nextCursor;
    }
    loaded.value = true;
  } catch (error) { if (!controller.signal.aborted) issue.value = errorMessage(error); }
  finally { loading.value = false; }
}
async function choose(topic: Topic) { selectedTopic.value = topic.id; query.value = ''; if (!loaded.value) await loadMore(); }
function addMember(choice: Choice) {
  const index = topics.value.findIndex(topic => topic.id === selectedTopic.value), topic = topics.value[index];
  if (!topic || topic.members.length >= TOPIC_LIMITS.members || topic.members.some(member => member.collection === choice.collection && member.id === choice.id)) return;
  update(index, { members: [...topic.members, { collection: choice.collection, id: choice.id }] });
}
</script>

<template>
  <section class="panel mt24 topics-editor" aria-labelledby="topics-heading">
    <div class="flex between"><div><h2 id="topics-heading">专题与系列</h2><p class="hint mt8">把文章、视频与相册按自己的顺序编成一组。</p></div><button type="button" :disabled="topics.length >= TOPIC_LIMITS.topics" @click="addTopic">添加专题</button></div>
    <p class="hint mt16">专题随网站设置一起发布。加入未发布内容时，请在发布清单中同时选择相应内容与网站设置；只展示该次发布里可公开的成员。空专题不会展示。</p>
    <p v-if="!topics.length" class="empty mt16">还没有专题。已有创作与相册保持原来的浏览方式。</p>
    <details v-for="(topic, index) in topics" :key="topic.id" class="topic-editor" open>
      <summary>{{ topic.title || '填写专题信息' }}<span class="hint">{{ topic.members.length }} 项 · {{ topic.enabled ? '发布时显示' : '暂不显示' }}</span></summary>
      <div class="topic-fields">
        <div class="form-grid"><label class="field">专题名称<input :value="topic.title" maxlength="120" required @input="update(index, { title: ($event.target as HTMLInputElement).value })"></label><label class="field">链接名称<input :value="topic.slug" maxlength="120" pattern="[a-z0-9]+(-[a-z0-9]+)*" required placeholder="my-series" @input="update(index, { slug: ($event.target as HTMLInputElement).value })"><small class="hint">小写英文字母、数字与短横线，发布后用于 /topics/ 链接。</small></label></div>
        <label class="field">专题引言<textarea :value="topic.intro" rows="3" maxlength="2000" @input="update(index, { intro: ($event.target as HTMLTextAreaElement).value })"></textarea></label>
        <label class="check"><input :checked="topic.enabled" type="checkbox" @change="update(index, { enabled: ($event.target as HTMLInputElement).checked })">发布时显示这个专题</label>
        <div class="flex between mt16"><h3>阅读顺序</h3><button type="button" :disabled="topic.members.length >= TOPIC_LIMITS.members" @click="choose(topic)">选择内容</button></div>
        <ol v-if="topic.members.length" class="topic-members"><li v-for="(member, position) in topic.members" :key="`${member.collection}/${member.id}`"><span>{{ memberLabel(member) }}</span><div class="flex"><button type="button" :disabled="position === 0" :aria-label="`将第 ${position + 1} 项前移`" @click="moveMember(index, position, -1)">↑</button><button type="button" :disabled="position === topic.members.length - 1" :aria-label="`将第 ${position + 1} 项后移`" @click="moveMember(index, position, 1)">↓</button><button type="button" :aria-label="`移除第 ${position + 1} 项`" @click="update(index, { members: topic.members.filter((_, i) => i !== position) })">移除</button></div></li></ol>
        <p v-else class="hint mt16">选择创作或相册，按顺序串起这个专题。</p>
        <div v-if="selectedTopic === topic.id" class="topic-picker mt16" @input.stop><label class="field">查找已加载内容<input v-model="query" type="search" placeholder="标题或内容 ID"></label><p v-if="issue" class="notice error" role="alert">{{ issue }}<button type="button" @click="loadMore">重试</button></p><ul><li v-for="choice in available" :key="`${choice.collection}/${choice.id}`"><span>{{ choice.draft.title || '未命名' }}<small class="hint">{{ choice.collection === 'albums' ? '相册' : '创作' }} · {{ visibilityLabel(choice.visibility) }}</small></span><button type="button" :disabled="topic.members.length >= TOPIC_LIMITS.members" @click="addMember(choice)">加入</button></li></ul><p v-if="loading" class="hint" role="status">正在读取内容…</p><p v-else-if="!available.length" class="hint">当前已加载的内容中没有匹配项。</p><div class="flex mt16"><button v-if="hasMore" type="button" :disabled="loading" @click="loadMore">加载更多内容</button><button type="button" @click="selectedTopic = ''">收起选择</button></div></div>
        <div class="flex between mt24"><div class="flex"><button type="button" :disabled="index === 0" @click="move(index, -1)">专题前移</button><button type="button" :disabled="index === topics.length - 1" @click="move(index, 1)">专题后移</button></div><button type="button" class="danger" @click="remove(index)">移除专题</button></div>
      </div>
    </details>
  </section>
</template>

<style scoped>
.topic-editor{margin-top:20px;border-top:1px solid var(--line);padding-top:16px}.topic-editor>summary{cursor:pointer;min-height:44px;font-size:18px;overflow-wrap:anywhere}.topic-editor>summary>span{margin-left:16px;font-size:12px}.topic-fields{padding-top:20px}.topic-members{padding-left:24px}.topic-members li{padding:12px 0;display:flex;gap:16px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);counter-increment:member}.topic-members{counter-reset:member}.topic-members li>span:before{content:counter(member,decimal-leading-zero) ' · ';color:var(--muted)}.topic-members li>span{overflow-wrap:anywhere;min-width:0;flex:1}.topic-members li>.flex{flex-shrink:0}.topic-picker{padding:20px;background:var(--paper);border:1px solid var(--line);border-radius:6px}.topic-picker ul{list-style:none;margin:0;padding:0;max-height:320px;overflow:auto}.topic-picker li{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}.topic-picker li>span{overflow-wrap:anywhere}.topic-picker small{display:block;margin-top:4px}@media(max-width:600px){.topic-members{padding-left:0}.topic-members li{align-items:flex-start;flex-direction:column}.topic-editor>summary>span{display:block;margin:6px 0}.topic-picker{padding:12px}}
</style>
