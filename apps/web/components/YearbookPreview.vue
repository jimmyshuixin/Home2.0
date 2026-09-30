<script setup lang="ts">
import { site, assetVariant, assetSrcSet } from '~/lib/site'
import { yearbook } from '~/lib/yearbook'

const book = yearbook(site)
const latest = book.years[0]
const images = latest?.entries.filter(entry => entry.kind === 'photo' && entry.imageAssetId && assetVariant(entry.imageAssetId)).slice(0, 3) || []
</script>

<template>
  <section v-if="latest" class="section yearbook-preview" aria-labelledby="yearbook-preview-heading">
    <div class="yearbook-preview-heading"><div><p class="yearbook-preview-kicker">循着年月，重看日常</p><h2 id="yearbook-preview-heading">岁月有迹<span class="dot" aria-hidden="true" /></h2><p>把公开的文字、照片与健身影像，收进同一条时间线。</p></div><NuxtLink class="text-link" to="/yearbook">翻开年鉴<SiteIcon name="arrow" :size="18" /></NuxtLink></div>
    <NuxtLink class="yearbook-preview-body" :class="{ 'has-photos': images.length }" :to="{ path: '/yearbook', query: { year: latest.year } }">
      <div class="yearbook-preview-year"><strong>{{ latest.year }}<span>年</span></strong><p>{{ latest.counts.creations }} 篇创作<span v-if="latest.counts.notes"> · {{ latest.counts.notes }} 则随记</span><br>{{ latest.counts.photos }} 张照片 · {{ latest.counts.fitness }} 条健身影像</p><small>已公开的片段，陆续收录</small></div>
      <div v-if="images.length" class="yearbook-preview-photos" aria-hidden="true"><img v-for="entry in images" :key="entry.id" :src="assetVariant(entry.imageAssetId)?.url" :srcset="assetSrcSet(entry.imageAssetId)" sizes="(max-width: 600px) 30vw, 220px" :width="assetVariant(entry.imageAssetId)?.width" :height="assetVariant(entry.imageAssetId)?.height" alt="" loading="lazy" decoding="async"></div>
    </NuxtLink>
  </section>
</template>

<style scoped>
.yearbook-preview-heading{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:30px}.yearbook-preview-kicker{font-size:11px!important;letter-spacing:.15em;color:var(--muted);margin:0 0 13px!important}.yearbook-preview-heading h2{margin:0 0 16px}.yearbook-preview-heading p{font-size:14px;line-height:1.9;color:var(--muted);margin:0}.yearbook-preview-heading>.text-link{white-space:nowrap;flex-shrink:0}.yearbook-preview-body{display:grid;grid-template-columns:minmax(0,1fr);gap:30px;text-decoration:none;color:inherit;border-block:1px solid var(--line);padding:30px 0}.yearbook-preview-body.has-photos{grid-template-columns:240px minmax(0,1fr);align-items:center}.yearbook-preview-year strong{font-size:62px;line-height:1.15;font-weight:400;color:var(--green)}.yearbook-preview-year strong>span{font-size:18px;margin-left:10px}.yearbook-preview-year p{font-size:13px;line-height:1.9;color:var(--muted);margin:14px 0 10px}.yearbook-preview-year small{font-size:11px;color:var(--muted)}.yearbook-preview-photos{display:flex;gap:16px;min-width:0;overflow:hidden;align-items:center}.yearbook-preview-photos img{display:block;min-width:0;width:calc((100% - 32px)/3);height:190px;object-fit:contain;flex:1;background:var(--paper,#f7f3e9)}.yearbook-preview-body:focus-visible{outline:2px solid var(--green);outline-offset:5px}@media(max-width:760px){.yearbook-preview-heading{align-items:start;flex-direction:column;gap:15px}.yearbook-preview-body.has-photos{grid-template-columns:minmax(0,1fr);gap:22px}.yearbook-preview-year strong{font-size:52px}.yearbook-preview-photos{gap:10px}.yearbook-preview-photos img{width:calc((100% - 20px)/3);height:150px}}@media(prefers-reduced-motion:no-preference){.yearbook-preview-body:hover .yearbook-preview-year strong{color:var(--red,#9d4336)}}
</style>
