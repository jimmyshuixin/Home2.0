<script setup lang="ts">
import { site, safeUrl } from '~/lib/site'
useSeoMeta({ title: '联系 · 虚宁', description: '关于创作、技术，或者一句简单的问候。欢迎写信给我。' })
</script>
<template><section class="page-heading"><h1>有想法，就聊一聊<span class="dot" aria-hidden="true" /></h1><p>关于创作、技术，或者一句简单的问候。</p></section><div class="contact-section"><div class="contact-copy"><h2>给我写一封信</h2><p>私信只用于与你联系，不会进入公开留言。</p><div v-if="site.settings.socialLinks.length" class="social-links"><a v-for="link in site.settings.socialLinks.filter((item) => safeUrl(item.url))" :key="link.url" :href="safeUrl(link.url)" target="_blank" rel="noopener noreferrer">{{ link.label }}<SiteIcon name="external" :size="18" /></a></div><NuxtLink class="text-link" to="/guestbook">想公开聊聊？去留言<SiteIcon name="arrow" :size="18" /></NuxtLink></div><ContactForm v-if="site.settings.contactEnabled" /><p v-else class="muted">私信表单暂时关闭，可以通过已公开的联系链接找到我。</p></div></template>
