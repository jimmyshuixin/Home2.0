<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { UploadMetadataSchema, type UploadMetadata } from '@xvyin/contracts';
import MediaPreview from './MediaPreview.vue';
import { api, errorMessage, formatBytes, type MediaItem } from '../api';
interface UploadSession { uploadId: string; assetId: string; partSize: number; totalParts: number; expiresAt: string; state: string; parts: {partNumber:number;etag:string;bytes:number}[] }
interface QueueItem { key: string; name: string; size: number; mime: string; sha256?: string; uploadId?: string; file?: File; sent: number; hashing: number; state: string; error: string }
const items = ref<MediaItem[]>([]); const queue = ref<QueueItem[]>([]); const quota = ref<{usedBytes:number;reservedBytes:number;limitBytes:number}>(); const error = ref(''); const loading = ref(true); const running = ref(false); const filter = ref('');
let controller = new AbortController();
const nextCursor=ref<string>();
const journalKey = 'xvyin-admin-upload-journal-v1';
function journal() { try { sessionStorage.setItem(journalKey, JSON.stringify(queue.value.filter(item => item.uploadId && !['processing','ready','cancelled'].includes(item.state)).map(({file,...metadata})=>metadata))); } catch { /* Resuming remains possible while this page stays open. */ } }
async function load(more=false) { loading.value=true;error.value=''; try { const response=await api.request<MediaItem[]>(('/admin/media'+(more&&nextCursor.value?'?cursor='+encodeURIComponent(nextCursor.value):'')));items.value=more?[...items.value,...response.data]:response.data;quota.value=response.meta.quota;nextCursor.value=response.meta.nextCursor; } catch(e) {error.value=errorMessage(e);} finally {loading.value=false;} }
function mime(file: File) { return file.type || ({ mp4:'video/mp4', webm:'video/webm', mp3:'audio/mpeg', m4a:'audio/mp4', wav:'audio/wav', ogg:'audio/ogg', aac:'audio/aac', jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', pdf:'application/pdf', txt:'text/plain', vtt:'text/vtt' } as Record<string,string>)[file.name.split('.').pop()?.toLowerCase() ?? ''] || ''; }
function metadata(item: QueueItem): UploadMetadata { const kind=item.mime.startsWith('image/')?'image':item.mime.startsWith('audio/')?'audio':item.mime.startsWith('video/')?'video':'file';return UploadMetadataSchema.parse({kind,originalName:item.name,expectedBytes:item.size,expectedMime:item.mime,expectedSha256:item.sha256}); }
async function checksum(item: QueueItem): Promise<string> {
  const { sha256 } = await import('@noble/hashes/sha2.js'); const hash=sha256.create(); const file=item.file!; const step=5*1024*1024;
  item.state='hashing';item.hashing=0;
  for(let start=0;start<file.size;start+=step) { if(controller.signal.aborted) throw new Error('上传已暂停。'); hash.update(new Uint8Array(await file.slice(start,start+step).arrayBuffer()));item.hashing=Math.min(file.size,start+step);await new Promise(resolve=>setTimeout(resolve,0)); }
  return Array.from(hash.digest(),byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function transfer(item: QueueItem) {
  if(!item.file || running.value) return;running.value=true;item.error='';controller=new AbortController();
  try {
    metadata(item);const digest=await checksum(item);
    if(item.sha256 && digest!==item.sha256) throw new Error('文件内容与原上传不一致，请重新选择原文件。');item.sha256=digest;
    let session:UploadSession;
    if(item.uploadId) session=(await api.request<UploadSession>(`/admin/media/uploads/${encodeURIComponent(item.uploadId)}`,{signal:controller.signal})).data;
    else { session=(await api.request<UploadSession>('/admin/media/uploads',{method:'POST',body:metadata(item),signal:controller.signal,idempotencyKey:item.key})).data;item.uploadId=session.uploadId; }
    if(session.state==='processing'||session.state==='ready') {item.state=session.state;item.sent=item.size;journal();await load();return;}
    if(['failed','expired','cancelled','aborted'].includes(session.state)) throw new Error('这次上传已结束或过期，请取消后重新上传。');
    const uploaded=new Map(session.parts.map(part=>[part.partNumber,part]));item.sent=session.parts.reduce((sum,part)=>sum+part.bytes,0);item.state='uploading';journal();
    for(let number=1;number<=session.totalParts;number++) {
      if(uploaded.has(number)) continue;
      const body=item.file.slice((number-1)*session.partSize,Math.min(number*session.partSize,item.size));
      const result=await api.request<{partNumber:number;etag:string;bytes:number}>(`/admin/media/uploads/${encodeURIComponent(session.uploadId)}/parts/${number}`,{method:'PUT',rawBody:body,signal:controller.signal});
      item.sent+=result.data.bytes;journal();
    }
    item.state='completing';
    await api.request(`/admin/media/uploads/${encodeURIComponent(session.uploadId)}/complete`,{method:'POST',body:{},signal:controller.signal,idempotencyKey:`${item.key}:complete`});
    item.state='processing';item.file=undefined;journal();await load();
  } catch(e) { item.state='paused';item.error=errorMessage(e);journal(); } finally {running.value=false;}
}
async function choose(event: Event, resume?: QueueItem) {
  const input=event.target as HTMLInputElement;const files=Array.from(input.files??[]);input.value='';
  if(resume) {const file=files[0];if(!file)return;if(file.size!==resume.size||file.name!==resume.name){resume.error='请选择同名、同大小的原文件；随后还会校验完整内容。';return;}resume.file=file;await transfer(resume);return;}
  for(const file of files) {const item:QueueItem={key:crypto.randomUUID(),name:file.name,size:file.size,mime:mime(file),file,sent:0,hashing:0,state:'queued',error:''};queue.value.push(item);const queued=queue.value[queue.value.length-1];if(queued)await transfer(queued);}
}
async function cancel(item:QueueItem) {if(running.value)return;try{if(item.uploadId)await api.request(`/admin/media/uploads/${encodeURIComponent(item.uploadId)}/abort`,{method:'POST',body:{}});item.state='cancelled';item.file=undefined;journal();await load();}catch(e){item.error=errorMessage(e);}}
const stateText:Record<string,string>={queued:'等待上传',hashing:'正在校验本地文件',uploading:'上传中',completing:'正在提交校验',processing:'等待服务端处理',ready:'可用于内容',paused:'已暂停',cancelled:'已取消',failed:'处理失败',validating:'服务端校验中',uploaded:'已上传'};
onMounted(()=>{try{const saved:unknown=JSON.parse(sessionStorage.getItem(journalKey)??'[]');if(Array.isArray(saved))queue.value=saved.filter(item=>typeof item.uploadId==='string'&&typeof item.sha256==='string'&&typeof item.name==='string'&&Number.isSafeInteger(item.size)).slice(0,20).map(item=>({...item,state:'paused',error:'重新选择原文件后继续上传。'}));}catch{/* Ignore malformed local resume metadata. */}void load();});
onBeforeUnmount(()=>{controller.abort();journal();});
</script>
<template><section><div class="panel media-upload"><div><h2>上传到媒体库</h2><p class="muted">图片、音频、视频和附件，统一保存与复用。</p><p class="hint mt16">单个视频最多 512 MB；上传完成后先校验与处理，完成前不能发布。</p></div><label class="button primary" :class="{disabled:running}"><input class="sr-only" type="file" multiple :disabled="running" accept="image/jpeg,image/png,image/webp,audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,video/mp4,video/webm,application/pdf,text/plain,text/vtt" @change="choose($event)">＋ 选择文件</label></div><div v-if="quota" class="quota panel mt24"><div class="flex between"><span>已用 {{ formatBytes(quota.usedBytes) }}，上传预留 {{ formatBytes(quota.reservedBytes) }}</span><strong>共 {{ formatBytes(quota.limitBytes) }}</strong></div><progress :max="quota.limitBytes" :value="quota.usedBytes+quota.reservedBytes" aria-label="媒体容量使用"></progress></div><div v-if="queue.length" class="panel mt24"><h2>上传队列</h2><article v-for="item in queue" :key="item.key" class="upload-row"><div class="flex between"><strong class="break">{{ item.name }}</strong><span class="badge">{{ stateText[item.state]??item.state }}</span></div><progress v-if="item.state==='hashing'" :max="item.size" :value="item.hashing" :aria-label="`${item.name} 本地校验进度`"></progress><progress v-else :max="item.size" :value="item.sent" :aria-label="`${item.name} 已确认上传字节`"></progress><small>{{ formatBytes(item.sent) }} / {{ formatBytes(item.size) }} 已由服务器确认</small><p v-if="item.error" class="error-text mt8" role="alert">{{ item.error }}</p><div class="flex mt8"><button v-if="running&&['uploading','hashing'].includes(item.state)" type="button" @click="controller.abort()">暂停</button><template v-if="item.state==='paused'"><button v-if="item.file" type="button" :disabled="running" @click="transfer(item)">重试未完成分片</button><label v-else class="button"><input type="file" class="sr-only" :disabled="running" @change="choose($event,item)">重新选择原文件</label><button type="button" :disabled="running" @click="cancel(item)">取消上传</button></template></div></article></div><div class="flex between mt32"><h2>全部媒体</h2><div class="flex"><select v-model="filter" aria-label="媒体类型筛选"><option value="">全部类型</option><option value="image">图片</option><option value="audio">音频</option><option value="video">视频</option><option value="file">附件</option></select><button type="button" @click="load()">刷新处理状态</button></div></div><p v-if="loading" class="loading" role="status">正在读取媒体…</p><div v-else-if="error" class="notice error mt16" role="alert">{{ error }} <button type="button" @click="load()">重试</button></div><div v-else-if="!items.length" class="empty mt16"><h3>媒体库还是空的</h3><p>上传第一份文件后，它会出现在这里。</p></div><div v-else class="media-grid mt24"><article v-for="item in items.filter(row=>!filter||row.kind===filter)" :key="item.id" class="media-card"><MediaPreview :item="item" compact/><div class="media-caption"><strong class="break">{{ item.originalName??item.id }}</strong><p class="hint">{{ formatBytes(item.originalBytes) }} <span v-if="item.metadata?.width">· {{ item.metadata?.width }} × {{ item.metadata?.height }}</span></p><p v-if="item.error" class="error-text mt8">{{item.error.message}}</p><span class="badge" :class="{green:(item.processingStatus??item.status)==='ready'}">{{ stateText[item.processingStatus??item.status??'']??'等待校验' }}</span></div></article></div><button v-if="nextCursor" class="mt24" :disabled="loading" @click="load(true)">加载更多媒体</button></section></template>

<style scoped>.media-grid{grid-template-columns:repeat(auto-fill,minmax(245px,1fr))}@media(max-width:600px){.media-grid{grid-template-columns:1fr}}</style>
