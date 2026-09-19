<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { formatBytes, type MediaItem } from '../api';
import { useUploadQueue, type UploadRow } from '../useUploadQueue';
const props = withDefaults(defineProps<{ kind?: string; embedded?: boolean; multiple?: boolean; maxFiles?: number }>(), { multiple: true, maxFiles: 100 });
const emit = defineEmits<{ changed: []; ready: [item: MediaItem] }>();
const upload = useUploadQueue(), owned = ref<string[]>([]), page = ref(1), pageSize = 8;
const completed = new Set<string>();
const visible = computed(() => props.embedded ? upload.rows.value.filter(row => owned.value.includes(row.key)) : upload.rows.value);
const pageCount = computed(() => Math.max(1, Math.ceil(visible.value.length / pageSize)));
const pageRows = computed(() => visible.value.slice((Math.min(page.value, pageCount.value) - 1) * pageSize, Math.min(page.value, pageCount.value) * pageSize));
const accepts: Record<string, string> = { image: 'image/jpeg,image/png,image/webp', audio: 'audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav', video: 'video/mp4,video/webm', file: 'application/pdf,text/plain,text/vtt' };
const accept = computed(() => props.kind ? accepts[props.kind] : Object.values(accepts).join(','));
const labels: Record<string, string> = { queued: '等待上传', hashing: '正在校验', uploading: '上传中', completing: '正在提交', processing: '服务器处理中', ready: '可用于内容', paused: '已暂停', failed: '处理失败', cancelled: '已取消', cancelling: '正在取消' };
let changeTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => visible.value.map(row => `${row.key}:${row.state}`).join('|'), () => {
  for (const row of visible.value) if (row.state === 'ready' && row.result && !completed.has(row.key)) {
    completed.add(row.key);
    if (owned.value.includes(row.key)) emit('ready', row.result);
  }
  clearTimeout(changeTimer); changeTimer = setTimeout(() => emit('changed'), 900);
});
onBeforeUnmount(() => clearTimeout(changeTimer));
function choose(event: Event, resume?: UploadRow) {
  const input = event.target as HTMLInputElement, files = Array.from(input.files || []); input.value = '';
  if (resume) { if (files[0]) void upload.resume(resume, files[0]); return; }
  // The shared queue reports anything beyond its capacity. Do not silently drop
  // files merely because this particular content has fewer available slots.
  const keys = upload.add(props.multiple ? files : files.slice(0, 1));
  owned.value.push(...keys); page.value = Math.max(1, Math.ceil(visible.value.length / pageSize));
}
</script>
<template>
  <section aria-label="上传媒体" :class="{ 'embedded-upload': embedded }">
    <div class="panel media-upload"><div><h2>{{ embedded ? '直接上传到这条内容' : '上传到媒体库' }}</h2><p class="muted">{{ embedded ? '处理完成后自动选中，无需离开编辑页面。' : '分批上传、自动续传，每个文件独立显示结果。' }}</p><p class="hint mt16">图片最多 100 MB，视频最多 512 MiB。队列最多 {{ upload.capacity }} 个未完成文件，同时最多处理 3 个，完成后自动继续。</p></div><label class="button primary" :class="{ disabled: upload.activeCount.value >= upload.capacity }"><input class="sr-only" type="file" :multiple="multiple" :disabled="upload.activeCount.value >= upload.capacity" :accept="accept" @change="choose($event)">＋ {{ multiple ? '选择文件上传' : '上传文件' }}</label></div>
    <p v-if="upload.issue.value" class="notice mt16" role="status">{{ upload.issue.value }}</p>
    <div v-if="visible.length" class="panel mt16"><div class="flex between"><h3>上传队列 · {{ visible.length }} 项</h3><div class="flex"><button v-if="upload.running.value" type="button" @click="upload.pause">暂停队列</button><button v-if="upload.paused.value" type="button" @click="upload.continue">继续队列</button><button v-if="!embedded" type="button" @click="upload.clear">清除已完成记录</button></div></div><p class="hint mt8">离开编辑弹窗后仍继续上传；刷新浏览器后，可重新选择原文件续传。处理完成才会允许关联发布。</p><article v-for="item in pageRows" :key="item.key" class="upload-row">
      <div class="flex between"><strong class="break">{{ item.name }}</strong><span class="badge">{{ labels[item.state] || item.state }}</span></div>
      <progress :max="item.size" :value="item.state === 'hashing' ? item.hashing : item.sent" :aria-label="`${item.name} 进度`" />
      <small>{{ formatBytes(item.sent) }} / {{ formatBytes(item.size) }}{{ item.reused ? ' · 已复用原有文件' : '' }}</small>
      <p v-if="item.error" class="error-text mt8" role="alert">{{ item.error }}</p>
      <div class="flex mt8"><template v-if="item.state === 'paused'"><button v-if="item.file" type="button" @click="upload.resume(item)">重试此文件</button><label v-else class="button"><input class="sr-only" type="file" @change="choose($event, item)">选择原文件续传</label></template><button v-if="['paused','queued','failed'].includes(item.state)" type="button" @click="upload.cancel(item)">从队列移除</button><button v-if="['processing','failed'].includes(item.state)" type="button" @click="upload.refresh(item)">刷新处理结果</button></div>
    </article><nav v-if="pageCount > 1" class="flex between mt16" aria-label="上传队列分页"><button type="button" :disabled="page <= 1" @click="page--">上一页</button><span>{{ Math.min(page, pageCount) }} / {{ pageCount }}</span><button type="button" :disabled="page >= pageCount" @click="page++">下一页</button></nav></div>
  </section>
</template>
<style scoped>.embedded-upload .media-upload{padding:20px}.embedded-upload h2{font-size:18px}.upload-row>div{gap:12px}.upload-row strong{min-width:0}.upload-row .badge{flex-shrink:0}.upload-row progress{width:100%}</style>
