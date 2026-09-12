<script setup lang="ts">
import { site } from '~/lib/site'
const route = useRoute(), menu = ref(false)
const config = useRuntimeConfig()
const nav = site.settings.navigation.length ? [...site.settings.navigation].filter((item) => item.enabled).sort((a, b) => a.sortOrder - b.sortOrder) : [{ label: '关于', href: '/about' }, { label: '创作', href: '/creations' }, { label: '摄影', href: '/photography' }, { label: '健身', href: '/fitness' }, { label: '留言', href: '/#guestbook' }, { label: '联系', href: '/contact' }]
const music = useMusic()
watch(() => route.fullPath, () => { menu.value = false })
function closeMenu(event: KeyboardEvent) { if (event.key === 'Escape') menu.value = false }
useHead(() => ({ htmlAttrs: { 'data-theme': site.settings.themePreference }, link: [{ rel: 'canonical', href: `${config.public.publicOrigin}${route.path}` }], meta: [{ property: 'og:url', content: `${config.public.publicOrigin}${route.path}` }] }))
onMounted(() => document.addEventListener('keydown', closeMenu))
onBeforeUnmount(() => document.removeEventListener('keydown', closeMenu))
</script>
<template><a class="skip-link" href="#main-content">跳到正文</a><div class="wrap"><header class="topbar"><NuxtLink class="brand" to="/" aria-label="虚宁，返回首页">虚宁</NuxtLink><button class="mobile-menu icon-button" :aria-expanded="menu" aria-controls="site-nav" :aria-label="menu ? '关闭导航' : '打开导航'" @click="menu = !menu"><SiteIcon :name="menu ? 'close' : 'menu'" /></button><nav id="site-nav" :class="{ 'is-open': menu }" aria-label="主导航"><NuxtLink v-for="item in nav" :key="item.href" :to="item.href" :aria-current="route.path.startsWith(item.href) ? 'page' : undefined">{{ item.label }}</NuxtLink></nav></header><main id="main-content" tabindex="-1"><NuxtPage /></main><footer class="footer"><div><p>{{ site.settings.copyright || '虚宁 · xvyin.com' }}</p><button v-if="music.track.value" class="footer-music quiet" :aria-label="music.playing.value ? '暂停音乐' : '播放音乐'" @click="music.toggle"><SiteIcon :name="music.playing.value ? 'pause' : 'play'" :size="18" /><span>{{ music.track.value.title }}</span></button></div><nav aria-label="页脚导航"><NuxtLink to="/about">关于</NuxtLink><NuxtLink to="/contact">联系</NuxtLink><NuxtLink to="/guestbook">全部留言</NuxtLink><a href="/admin">管理</a></nav></footer></div><MusicEngine /></template>
