<script setup lang="ts">defineProps<{ error: { statusCode?: number } }>()</script>
<template><div class="wrap error-page"><NuxtLink to="/" class="brand">虚宁</NuxtLink><h1>{{ error.statusCode === 404 ? '这一页暂时找不到。' : '页面暂时无法打开。' }}</h1><p class="muted">可以回到首页，继续看看创作与日常。</p><a class="button primary" href="/">返回首页</a></div></template>
