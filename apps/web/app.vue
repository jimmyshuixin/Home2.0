<script setup lang="ts">
import { site } from '~/lib/site'
const route = useRoute(), menu = ref(false)
const menuButton = ref<HTMLButtonElement | null>(null)
const config = useRuntimeConfig()
const nav = site.settings.navigation.length ? [...site.settings.navigation].filter((item) => item.enabled).sort((a, b) => a.sortOrder - b.sortOrder) : [{ label: '关于', href: '/about' }, { label: '创作', href: '/creations' }, { label: '摄影', href: '/photography' }, { label: '健身', href: '/fitness' }, { label: '留言', href: '/#guestbook' }, { label: '联系', href: '/contact' }]
watch(() => route.fullPath, () => { menu.value = false })
function closeMenu(event: KeyboardEvent) {
  if (event.key === 'Escape' && menu.value) {
    menu.value = false
    menuButton.value?.focus()
  }
}
useHead(() => ({ htmlAttrs: { 'data-theme': site.settings.themePreference }, link: [{ rel: 'canonical', href: `${config.public.publicOrigin}${route.path}` }], meta: [{ property: 'og:url', content: `${config.public.publicOrigin}${route.path}` }] }))
onMounted(() => document.addEventListener('keydown', closeMenu))
onBeforeUnmount(() => document.removeEventListener('keydown', closeMenu))
</script>
<template><a class="skip-link" href="#main-content">跳到正文</a><div :class="['wrap', { 'freepaper-shell': route.path === '/' }]"><header class="topbar"><NuxtLink class="brand" to="/" aria-label="虚宁，返回首页">虚宁</NuxtLink><button ref="menuButton" class="mobile-menu icon-button" :aria-expanded="menu" aria-controls="site-nav" :aria-label="menu ? '关闭导航' : '打开导航'" @click="menu = !menu"><SiteIcon :name="menu ? 'close' : 'menu'" /></button><nav id="site-nav" :class="{ 'is-open': menu }" aria-label="主导航"><NuxtLink v-for="item in nav" :key="item.href" :to="item.href" :aria-current="route.path.startsWith(item.href) ? 'page' : undefined">{{ item.label }}</NuxtLink></nav></header><main id="main-content" tabindex="-1"><NuxtPage /></main><SiteFooter /></div><MusicEngine /></template>
