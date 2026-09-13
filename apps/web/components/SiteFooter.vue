<script setup lang="ts">
import { site } from '~/lib/site'
const music = useMusic()
</script>

<template>
  <footer class="site-footer">
    <div class="footer-main">
      <div class="footer-signature"><NuxtLink to="/" class="footer-brand" aria-label="虚宁，返回首页">虚宁</NuxtLink><p>{{ site.settings.copyright || '虚宁 · xvyin.com' }}</p></div>
      <nav aria-label="页脚导航"><NuxtLink to="/about">关于</NuxtLink><NuxtLink to="/contact">联系</NuxtLink><NuxtLink to="/guestbook">留言</NuxtLink><a href="/admin/">管理</a></nav>
    </div>
    <div v-if="music.track.value?.title" class="footer-listening">
      <span class="listening-label">{{ music.pendingPlay.value ? '此刻在听' : '留一首歌' }}</span>
      <button class="footer-track" :aria-label="`${music.resolving.value ? '取消加载' : music.pendingPlay.value ? '暂停' : '播放'}：${music.track.value.title}`" :aria-busy="music.resolving.value" :disabled="!music.canPlay.value" @click="music.toggle">
        <span class="footer-play"><SiteIcon :name="music.pendingPlay.value ? 'pause' : 'play'" :size="16" /></span>
        <span class="footer-track-copy"><span>{{ music.track.value.title }}</span><small v-if="music.track.value.artist">{{ music.track.value.artist }}</small></span>
      </button>
    </div>
  </footer>
</template>

<style scoped>
.site-footer{margin-top:clamp(64px,9vw,112px);padding:clamp(28px,4vw,44px) 0 32px;border-top:1px solid var(--line);color:var(--muted);font-size:13px;min-width:0}
.footer-main{display:flex;align-items:center;justify-content:space-between;gap:32px}.footer-signature{display:flex;align-items:center;gap:22px;min-width:0}.footer-brand{font:38px/1.2 XuBrush,serif;color:var(--green);flex-shrink:0}.footer-signature p{margin:0;line-height:1.8;max-width:34ch;white-space:pre-line}.site-footer nav{display:flex;gap:clamp(16px,3vw,38px);flex-wrap:wrap}.site-footer nav a{display:flex;align-items:center;justify-content:center;min-height:44px;white-space:nowrap;font-size:14px}.footer-listening{display:flex;gap:20px;align-items:center;margin-top:22px;min-width:0}.listening-label{font-size:11px;letter-spacing:.12em;white-space:nowrap}.footer-track{border:0;padding:0;min-height:44px;max-width:min(440px,100%);min-width:0;justify-content:flex-start;gap:12px;text-align:left}.footer-track:hover:not(:disabled){background:transparent;color:var(--green)}.footer-play{width:30px;height:30px;border:1px solid var(--line);border-radius:50%;display:grid;place-items:center;flex-shrink:0}.footer-track-copy{min-width:0;display:flex;align-items:baseline;gap:12px;font-size:13px}.footer-track-copy>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.footer-track-copy small{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:16ch}
@media(max-width:640px){.site-footer{padding:28px 0 max(24px,env(safe-area-inset-bottom));margin-top:64px}.footer-main{display:block}.footer-signature{justify-content:space-between;gap:20px}.footer-brand{font-size:34px}.footer-signature p{font-size:12px;text-align:right;max-width:26ch}.site-footer nav{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:20px}.site-footer nav a{justify-content:flex-start;font-size:13px}.site-footer nav a:last-child{justify-content:flex-end}.site-footer nav a:nth-child(2),.site-footer nav a:nth-child(3){justify-content:center}.footer-listening{border-top:1px solid var(--line);padding-top:14px;margin-top:12px;gap:16px}.footer-track{flex:1}.footer-track-copy{display:block;line-height:1.55}.footer-track-copy>span,.footer-track-copy small{display:block;max-width:100%}.listening-label{font-size:10px}.footer-track-copy small{margin-top:2px}}
</style>
