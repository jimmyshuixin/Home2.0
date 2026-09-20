<script setup lang="ts">
const open = ref(false)
</script>

<template>
  <section id="guestbook" class="panel guestbook-panel" aria-labelledby="guestbook-title">
    <div class="panel-head"><h3 id="guestbook-title">留言弹幕</h3></div>
    <CommentList compact presentation="lanes" />
    <div class="actions guestbook-actions">
      <button class="primary guestbook-write" @click="open = true">写一条留言 <SiteIcon name="arrow" :size="20" /></button>
    </div>
    <div class="guestbook-secondary">
      <NuxtLink class="text-link" to="/guestbook">查看全部留言 <SiteIcon name="external" :size="18" /></NuxtLink>
      <p class="small muted">审核后公开展示，无需注册。</p>
    </div>
    <AppDialog v-model="open" title="留一句话"><CommentForm /></AppDialog>
  </section>
</template>

<style src="../assets/ink-guestbook.css"></style>
