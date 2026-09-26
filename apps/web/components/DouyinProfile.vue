<script setup lang="ts">
const profileUrl = 'https://www.douyin.com/user/MS4wLjABAAAAKZ2zSL9DDu1Uc3IZleN2zqIqoOpNXtwvAW4_2E6PBrLmkyTMw_MsrzxGVrQvvI1-'
const video = { id: 'douyin-7661639577056136457', type: 'video', providerRef: { provider: 'douyin', contentId: '7661639577056136457' }, aspectRatio: 1.5 } as const
</script>

<template>
  <section class="douyin-profile" aria-label="我的抖音">
    <div class="douyin-heading"><p class="douyin-eyebrow">抖音 · 摄影与日常</p><a :href="profileUrl" target="_blank" rel="noopener noreferrer" class="text-link">抖音主页 <SiteIcon name="external" :size="16" /></a></div>
    <div class="douyin-overview"><span class="douyin-avatar" aria-hidden="true">光</span><div><h2>虚宁</h2><p class="douyin-handle">抖音号 tidingjinluo</p></div><p class="douyin-intro">把摄影里的发现，留在影像里。</p></div>
    <div class="douyin-work"><p class="douyin-eyebrow">精选公开视频</p><h3>学习摄影必会技能之一：星空摄影，星轨，银河</h3><ContentMedia :block="video" /></div>
    <p class="douyin-status">这里展示已收录的公开作品；最新作品与账号数据请见抖音主页。</p>
  </section>
</template>

<style scoped>
.douyin-profile{min-width:0;margin:0 0 clamp(36px,5vw,64px);padding:clamp(22px,3vw,32px) 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.douyin-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}.douyin-heading .text-link{font-size:13px;white-space:nowrap}.douyin-eyebrow{font-size:12px;letter-spacing:.12em;color:var(--muted);margin:0}.douyin-overview{display:flex;align-items:center;gap:20px}.douyin-avatar{display:grid;place-items:center;flex:0 0 72px;width:72px;height:72px;border-radius:50%;font:38px/1 var(--serif);color:var(--green);background:var(--panel)}.douyin-overview h2{font-size:clamp(23px,3vw,30px);font-weight:400;margin:0;line-height:1.4}.douyin-handle{font-size:11px;letter-spacing:.06em;color:var(--muted);margin:4px 0 0}.douyin-intro{margin:0 0 0 auto;font-size:14px;color:var(--muted);line-height:1.8}.douyin-work{margin-top:28px;max-width:800px}.douyin-work h3{font-size:clamp(18px,2.2vw,23px);font-weight:400;line-height:1.6;margin:12px 0 18px}.douyin-status{font-size:11px;color:var(--muted);line-height:1.8;margin:20px 0 0}
@media(max-width:600px){.douyin-overview{flex-wrap:wrap;gap:16px}.douyin-avatar{flex-basis:60px;width:60px;height:60px}.douyin-intro{flex-basis:100%;margin:0;font-size:13px}.douyin-heading{margin-bottom:18px}.douyin-work{margin-top:22px}}
</style>
