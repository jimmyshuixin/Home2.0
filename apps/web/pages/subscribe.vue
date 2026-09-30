<script setup lang="ts">
const config = useRuntimeConfig()
useSeoMeta({ title: '订阅更新 · 虚宁', description: '用阅读器订阅虚宁的创作、随记与摄影，慢慢读，不错过。' })
</script>
<template><section class="subscribe-page"><header class="page-head"><p class="eyebrow">SUBSCRIBE</p><h1>把更新，放进你的阅读器。</h1><p>新的创作、随记与摄影，会在这里相遇。</p></header><div class="prose"><p>将下面的订阅地址添加到你常用的 RSS 阅读器，就能收到本站已公开的创作、随记和相册更新，无需注册账号。</p><div class="feed-links"><a href="/feed.xml">RSS 订阅 <span aria-hidden="true">↗</span></a><code>{{ config.public.publicOrigin }}/feed.xml</code><a href="/feed.json">JSON Feed <span aria-hidden="true">↗</span></a><code>{{ config.public.publicOrigin }}/feed.json</code></div><p class="muted">订阅包含最近 100 篇创作与相册。照片、视频和互动内容可回到原文浏览。</p></div></section></template>
<style scoped>.subscribe-page{max-width:760px;margin:0 auto}.feed-links{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:16px 28px;margin:32px 0;align-items:center}.feed-links a{min-height:44px;display:flex;align-items:center;gap:14px;color:var(--green)}.feed-links code{overflow-wrap:anywhere;font-size:13px}@media(max-width:640px){.feed-links{grid-template-columns:1fr;gap:8px}.feed-links code{margin-bottom:12px}}</style>
