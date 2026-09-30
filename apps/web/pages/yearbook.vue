<script setup lang="ts">
import { site, assetVariant, assetSrcSet } from '~/lib/site'
import { yearbook, yearbookCounts, yearbookDateLabels, yearbookKindLabels, yearbookSelection } from '~/lib/yearbook'

const book = yearbook(site)
const route = useRoute()
const queryYear = ref<unknown>('')
onMounted(() => { queryYear.value = route.query.year })
watch(() => route.query.year, value => { queryYear.value = value })
const selected = computed(() => yearbookSelection(book, queryYear.value))
const current = computed(() => book.years.find(item => item.year === selected.value))
const months = computed(() => selected.value === 'unknown' ? [{ month: 'unknown', entries: book.unknown }] : current.value?.months || [])
const counts = computed(() => current.value?.counts || yearbookCounts(selected.value === 'unknown' ? book.unknown : []))
const limits = ref<Record<string, number>>({})
const currentYear = ref('')
onMounted(() => { currentYear.value = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()) })
watch(selected, () => { limits.value = {} })
const intro = computed(() => selected.value === 'unknown' ? '日期还未确定的公开片段，暂留在这里。'
  : selected.value === currentYear.value ? '这一年仍在继续，先把已经公开的片段收在这里。' : '循着已记录的日期，重看这一年的文字、影像与日常。')
const visible = (month: string) => limits.value[month] || 12
function showMore(month: string) { limits.value = { ...limits.value, [month]: visible(month) + 12 } }
const monthAnchor = (month: string) => `yearbook-${selected.value}-${month}`
useSeoMeta({ title: '年鉴 · 虚宁', description: '循着年月，重看已经公开的创作、照片与健身影像。' })
</script>

<template>
  <div class="yearbook-page">
    <header class="page-heading yearbook-heading">
      <p class="yearbook-eyebrow">岁月有迹</p>
      <h1>把日常，收进年鉴<span class="dot" aria-hidden="true" /></h1>
      <p>文字、照片，还有日复一日留下的变化。</p>
    </header>

    <template v-if="book.years.length || book.unknown.length">
      <nav class="yearbook-years" aria-label="选择年鉴年份">
        <NuxtLink v-for="year in book.years" :key="year.year" :to="{ path: '/yearbook', query: { year: year.year } }" :aria-current="selected === year.year ? 'page' : undefined">{{ year.year }}<span>年</span></NuxtLink>
        <NuxtLink v-if="book.unknown.length" class="yearbook-undated" :to="{ path: '/yearbook', query: { year: 'unknown' } }" :aria-current="selected === 'unknown' ? 'page' : undefined">日期未详</NuxtLink>
      </nav>

      <section class="yearbook-overview" aria-labelledby="yearbook-selected-heading">
        <div><p class="yearbook-eyebrow">{{ selected === 'unknown' ? '等待补全日期' : '已公开的片段' }}</p><h2 id="yearbook-selected-heading">{{ selected === 'unknown' ? '日期未详' : selected }}<span v-if="selected !== 'unknown'">年</span></h2><p class="yearbook-intro">{{ intro }}</p></div>
        <dl class="yearbook-counts" aria-label="当前公开记录数量">
          <div><dt>创作</dt><dd>{{ counts.creations }}<span>篇</span></dd></div>
          <div v-if="counts.notes"><dt>随记</dt><dd>{{ counts.notes }}<span>则</span></dd></div>
          <div><dt>照片</dt><dd>{{ counts.photos }}<span>张</span></dd></div>
          <div><dt>健身影像</dt><dd>{{ counts.fitness }}<span>条记录</span></dd></div>
        </dl>
      </section>

      <details class="yearbook-method">
        <summary>这些片段如何按年月收录</summary>
        <p>创作与随记按北京时间的公开日期收录；照片优先使用手动填写的拍摄日期，其次使用公开 EXIF 中记录的本地拍摄日期。缺少拍摄日期时，按相册发布日收录并单独标注。</p>
        <p>同一素材在多个相册出现只计一张照片；多处日期不同时优先采用手动日期，同类日期按相册排列顺序选取。健身只统计有记录的影像条目，不代表训练次数或连续打卡天数。照片数不重复计入创作插图和健身影像。</p>
      </details>

      <nav v-if="selected !== 'unknown'" class="yearbook-month-nav" aria-label="跳转到月份">
        <a v-for="month in months" :key="month.month" :href="`#${monthAnchor(month.month)}`">{{ Number(month.month) }} 月<span>{{ month.entries.length }} 个片段</span></a>
      </nav>

      <section v-for="month in months" :id="monthAnchor(month.month)" :key="`${selected}-${month.month}`" class="yearbook-month" :aria-labelledby="`${monthAnchor(month.month)}-heading`">
        <div class="yearbook-month-label"><h2 :id="`${monthAnchor(month.month)}-heading`">{{ month.month === 'unknown' ? '未详' : month.month }}<span v-if="month.month !== 'unknown'">月</span></h2><p>{{ month.entries.length }} 个片段</p></div>
        <div class="yearbook-month-content">
          <ol class="yearbook-entries">
            <li v-for="entry in month.entries.slice(0, visible(month.month))" :key="entry.id" class="yearbook-entry" :class="{ 'yearbook-entry-photo': entry.kind === 'photo' }">
              <NuxtLink v-if="entry.imageAssetId && assetVariant(entry.imageAssetId)" :to="entry.href" class="yearbook-image"><img :src="assetVariant(entry.imageAssetId)?.url" :srcset="assetSrcSet(entry.imageAssetId)" sizes="(max-width: 700px) calc(100vw - 48px), (max-width: 1000px) 40vw, 390px" :width="assetVariant(entry.imageAssetId)?.width" :height="assetVariant(entry.imageAssetId)?.height" :alt="entry.imageAlt" loading="lazy" decoding="async"></NuxtLink>
              <div class="yearbook-entry-copy">
                <p class="yearbook-entry-meta"><span>{{ yearbookKindLabels[entry.kind] }}</span><time v-if="entry.date" :datetime="entry.date">{{ entry.date.slice(5).replace('-', '.') }}</time></p>
                <h3><NuxtLink :to="entry.href">{{ entry.title }}</NuxtLink></h3>
                <p v-if="entry.description && entry.kind !== 'photo'" class="yearbook-entry-description">{{ entry.description }}</p>
                <p class="yearbook-date-source">{{ yearbookDateLabels[entry.dateSource] }}</p>
                <div v-if="entry.sources.length" class="yearbook-sources"><span>收录于</span><NuxtLink v-for="source in entry.sources" :key="source.id" :to="source.href">「{{ source.title }}」</NuxtLink></div>
                <NuxtLink v-else class="text-link yearbook-entry-link" :to="entry.href">{{ entry.kind === 'fitness' ? '查看健身影像' : entry.kind === 'note' ? '阅读随记' : '阅读创作' }}<SiteIcon name="arrow" :size="15" /></NuxtLink>
              </div>
            </li>
          </ol>
          <button v-if="month.entries.length > visible(month.month)" type="button" class="yearbook-more" @click="showMore(month.month)">继续展开{{ month.month === 'unknown' ? '' : '这个月' }}（还有 {{ month.entries.length - visible(month.month) }} 个片段）</button>
        </div>
      </section>
      <p class="yearbook-ending">只收录已经公开的内容。年鉴会随新的公开记录慢慢生长。</p>
    </template>
    <section v-else class="empty-state"><h2>年鉴还在等待第一个片段</h2><p>公开的创作、照片与健身影像，会在这里按时间相遇。</p><NuxtLink class="text-link" to="/creations">去看看创作<SiteIcon name="arrow" :size="18" /></NuxtLink></section>
  </div>
</template>

<style scoped>
.yearbook-page{max-width:1120px;margin:0 auto}.yearbook-heading{margin-bottom:46px}.yearbook-eyebrow{font-size:12px!important;letter-spacing:.2em;color:var(--muted);margin:0 0 15px!important}.yearbook-years{display:flex;align-items:baseline;flex-wrap:wrap;gap:16px 34px;border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:44px}.yearbook-years>a{font-size:28px;color:var(--muted);text-decoration:none;padding:4px 0;position:relative;min-height:44px}.yearbook-years>a>span{font-size:12px;margin-left:5px}.yearbook-years>a[aria-current]{color:var(--green)}.yearbook-years>a[aria-current]::after{content:'';position:absolute;bottom:-19px;left:0;right:0;height:2px;background:var(--red,#9d4336)}.yearbook-years>.yearbook-undated{font-size:15px}.yearbook-overview{display:flex;justify-content:space-between;align-items:center;gap:35px;margin-bottom:30px}.yearbook-overview h2{font-size:clamp(48px,8vw,86px);line-height:1.1;font-weight:400;letter-spacing:-.035em;margin:0}.yearbook-overview h2>span{font-size:22px;letter-spacing:0;margin-left:14px}.yearbook-intro{color:var(--muted);font-size:14px;line-height:1.9;margin:19px 0 0;max-width:30em}.yearbook-counts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:24px 34px;margin:0;max-width:430px}.yearbook-counts dt{font-size:12px;color:var(--muted);margin-bottom:9px}.yearbook-counts dd{font-size:34px;margin:0;font-variant-numeric:tabular-nums;line-height:1.3}.yearbook-counts dd>span{font-size:11px;color:var(--muted);margin-left:8px;white-space:nowrap}.yearbook-method{font-size:12px;color:var(--muted);line-height:1.9;max-width:850px;margin:0 0 36px}.yearbook-method summary{cursor:pointer;min-height:32px;display:list-item}.yearbook-method p{margin:10px 0}.yearbook-month-nav{display:flex;flex-wrap:wrap;gap:14px 30px;margin:0 0 62px;padding-top:24px;border-top:1px solid var(--line)}.yearbook-month-nav a{color:var(--green);font-size:16px;text-decoration:none;min-height:44px;padding:7px 0}.yearbook-month-nav span{font-size:11px;color:var(--muted);margin-left:10px}.yearbook-month{display:grid;grid-template-columns:110px minmax(0,1fr);gap:40px;padding-top:28px;border-top:1px solid var(--line);margin:0 0 62px;scroll-margin-top:110px}.yearbook-month-label h2{font-size:49px;font-weight:400;line-height:1.2;margin:0;color:var(--green)}.yearbook-month-label h2>span{font-size:15px;margin-left:7px}.yearbook-month-label p{font-size:11px;color:var(--muted);margin:12px 0}.yearbook-month-content{min-width:0}.yearbook-entries{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:38px 32px;list-style:none;margin:0;padding:0}.yearbook-entry{min-width:0}.yearbook-image{display:block;aspect-ratio:3/2;overflow:hidden;background:var(--line);margin-bottom:19px}.yearbook-image img{display:block;width:100%;height:100%;object-fit:contain;background:var(--paper,#f7f3e9)}.yearbook-entry-meta{display:flex;align-items:center;gap:14px;font-size:11px;color:var(--muted);margin:0 0 11px;letter-spacing:.06em}.yearbook-entry-meta>span{color:var(--green)}.yearbook-entry h3{font-size:22px;font-weight:400;line-height:1.6;margin:0 0 12px;overflow-wrap:anywhere}.yearbook-entry h3 a{color:inherit;text-decoration:none}.yearbook-entry h3 a:hover{color:var(--green)}.yearbook-entry-description{font-size:14px;line-height:1.9;color:var(--muted);white-space:pre-line;overflow-wrap:anywhere;margin:0 0 14px}.yearbook-date-source{font-size:11px;line-height:1.7;color:var(--muted);margin:8px 0}.yearbook-sources{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px;font-size:12px;line-height:1.8;overflow-wrap:anywhere}.yearbook-sources>span{color:var(--muted)}.yearbook-sources>a{color:var(--green);text-decoration:none}.yearbook-entry-link{font-size:12px;margin-top:6px}.yearbook-more{display:block;margin:34px auto 0;padding:12px 20px;background:none;border:1px solid var(--line);font:inherit;font-size:13px;color:var(--green);cursor:pointer;max-width:100%}.yearbook-ending{font-size:12px;line-height:1.9;text-align:center;color:var(--muted);margin:70px 0 80px}.yearbook-page a:focus-visible,.yearbook-page button:focus-visible,.yearbook-method summary:focus-visible{outline:2px solid var(--green);outline-offset:5px}
@media(max-width:850px){.yearbook-overview{align-items:flex-start;flex-direction:column;gap:28px}.yearbook-counts{justify-content:flex-start;gap:22px 35px;max-width:none}.yearbook-month{grid-template-columns:75px minmax(0,1fr);gap:25px}.yearbook-entries{gap:34px 23px}.yearbook-entry h3{font-size:20px}}
@media(max-width:600px){.yearbook-heading{margin-bottom:32px}.yearbook-years{gap:15px 25px;margin-bottom:32px}.yearbook-years>a{font-size:26px}.yearbook-overview h2{font-size:60px}.yearbook-counts{gap:18px 25px}.yearbook-counts dd{font-size:29px}.yearbook-counts dd>span{margin-left:5px}.yearbook-method{margin-bottom:24px}.yearbook-month-nav{gap:5px 20px;margin-bottom:36px}.yearbook-month-nav a{font-size:15px}.yearbook-month-nav span{font-size:10px;margin-left:7px}.yearbook-month{grid-template-columns:minmax(0,1fr);gap:20px;margin-bottom:46px;padding-top:23px}.yearbook-month-label{display:flex;align-items:baseline;gap:18px}.yearbook-month-label h2{font-size:37px}.yearbook-entries{grid-template-columns:minmax(0,1fr);gap:35px}.yearbook-entry h3{font-size:22px}.yearbook-image{margin-bottom:16px;max-height:420px}.yearbook-ending{text-align:left;margin:48px 0 65px}}
.yearbook-page header.yearbook-heading{padding-top:64px;padding-bottom:26px;margin-bottom:24px}.yearbook-years>a[aria-current]::after{bottom:-5px}.yearbook-month-nav{margin-bottom:38px}@media(max-width:600px){.yearbook-page header.yearbook-heading{padding-top:38px;padding-bottom:16px;margin-bottom:18px}.yearbook-years{row-gap:10px}}
</style>
