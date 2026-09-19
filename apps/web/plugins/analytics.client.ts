import { analyticsAllowed, ForegroundClock, visitorId, type EngagementTarget } from '~/lib/engagement'
import { site } from '~/lib/site'

export default defineNuxtPlugin((nuxtApp) => {
  const router = useRouter()
  const base = String(useRuntimeConfig().public.apiBase)
  type Visit = { visitorId: string; visitId: string; startedAt: number; path: string; target?: EngagementTarget; clock: ForegroundClock; lastSent: number }
  let visit: Visit | null = null, stopForQuota = false, mounted = false
  const foreground = () => document.visibilityState === 'visible' && document.hasFocus()
  function send(type: 'start' | 'heartbeat' | 'end', unloading = false) {
    const current = visit
    if (!current || !analyticsAllowed() || stopForQuota) return
    const activeMs = current.clock.milliseconds()
    if (type === 'heartbeat' && activeMs <= current.lastSent) return
    current.lastSent = activeMs
    const { clock: _clock, lastSent: _lastSent, ...fields } = current
    const body = JSON.stringify({ ...fields, type, activeMs })
    if (unloading && navigator.sendBeacon?.(`${base}/analytics/visit`, new Blob([body], { type: 'application/json' }))) return
    void fetch(`${base}/analytics/visit`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body, keepalive: unloading, signal: AbortSignal.timeout(12000) }).then(async response => {
      if (response.status === 429) stopForQuota = true
      if (response.ok) {
        const result = await response.json().catch(() => null)
        if (result?.data?.recorded === false && ['free_daily_budget', 'daily_visit_limit', 'privacy_or_admin'].includes(result.data.reason)) stopForQuota = true
      }
    }).catch(() => { /* Statistics must never prevent reading or navigation. */ })
  }
  function start(targetOverride?: EngagementTarget) {
    if (!mounted) return
    if (visit) { visit.clock.setActive(false); send('end'); visit = null }
    const path = router.currentRoute.value.path
    const normalized = path.replace(/\/$/, '')
    if (!analyticsAllowed() || stopForQuota || path.startsWith('/admin') || site.releaseId === 'unpublished') return
    const creation = site.creations.find(item => `/creations/${item.slug}` === normalized)
    const album = site.albums.find(item => `/photography/${item.slug}` === normalized)
    const target = targetOverride || (creation ? { type: 'creation' as const, id: creation.id } : album ? { type: 'album' as const, id: album.id } : undefined)
    const clock = new ForegroundClock(() => performance.now())
    clock.setActive(foreground())
    visit = { visitorId: visitorId(), visitId: crypto.randomUUID(), startedAt: Date.now(), path, ...(target ? { target } : {}), clock, lastSent: -1 }
    send('start')
  }
  const stateChanged = () => {
    if (!visit && foreground()) start()
    visit?.clock.setActive(foreground())
    if (!foreground()) send('heartbeat', true)
  }
  const pagehide = () => { visit?.clock.setActive(false); send('end', true); visit = null }
  const privacy = () => { if (!analyticsAllowed()) visit = null; else start() }
  const photo = (event: Event) => start((event as CustomEvent<EngagementTarget | undefined>).detail)
  nuxtApp.hook('app:mounted', () => {
    mounted = true
    start()
    document.addEventListener('visibilitychange', stateChanged)
    window.addEventListener('focus', stateChanged)
    window.addEventListener('blur', stateChanged)
    window.addEventListener('pagehide', pagehide)
    window.addEventListener('pageshow', stateChanged)
    window.addEventListener('xvyin-privacy-change', privacy)
    window.addEventListener('xvyin-photo-view', photo)
    window.setInterval(() => { if (foreground()) send('heartbeat') }, 60_000)
  })
  router.afterEach((to, from, failure) => { if (!failure && to.path !== from.path) start() })
})
