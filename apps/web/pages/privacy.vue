<script setup lang="ts">
import { analyticsAllowed, setAnalyticsAllowed } from '~/lib/engagement'
const allowed = ref(false), ready = ref(false)
onMounted(() => { allowed.value = analyticsAllowed(); ready.value = true })
function change() { setAnalyticsAllowed(!allowed.value); allowed.value = analyticsAllowed() }
useSeoMeta({ title: '访问记录说明 · 虚宁', description: '了解本站的访问记录、照片信息和点赞功能。' })
</script>
<template><div class="reading-page"><header class="article-head"><p class="eyebrow">PRIVACY</p><h1>访问记录说明</h1><p class="summary">让网站更好用，也让每一项记录说得清楚。</p></header><article class="prose"><h2>网站会记录什么</h2><p>为了解哪些内容受到关注，本站会记录访问时间、访问的页面或照片、网络 IP、由网络服务提供的国家与城市等大致区域，以及页面在前台获得焦点时的浏览时长。IP 的归属地可能与实际位置不同，本站不请求设备的精确定位。</p><p>这些明细仅供网站管理员查看，保留期限为 30 天。访问时长是浏览器上报的估算值；关闭页面、断网、拒绝统计或免费服务达到额度时，记录可能不完整。本站不会把估算值描述为精确的阅读时间。</p><h2>你可以选择</h2><p>本站尊重浏览器的“请勿跟踪”和全局隐私控制信号。你也可以在这里关闭本浏览器的访问统计，继续正常浏览与点赞。</p><button v-if="ready" :aria-pressed="allowed" @click="change">{{ allowed ? '关闭本浏览器的访问统计' : '尝试开启本浏览器的访问统计' }}</button><p v-if="ready" class="small muted" role="status">当前：{{ allowed ? '已开启访问统计' : '未开启访问统计（浏览器的隐私设置也会生效）' }}。</p><h2>点赞与照片信息</h2><p>点赞无需注册。浏览器保存一个随机标识，用于记住点赞状态，方便再次点击取消。清除浏览器数据或更换设备后，状态可能改变；点赞数不代表经过身份核验的人数。</p><p>照片可展示作者相机文件自带的相机、镜头、焦距、光圈、快门、ISO 和拍摄日期。不公开照片中的 GPS、设备序列号或作者私有标识。没有记录的参数保持空白。</p><h2>联系</h2><p>如需询问本站的访问记录，请通过<NuxtLink to="/contact">联系页面</NuxtLink>留言。</p></article></div></template>
