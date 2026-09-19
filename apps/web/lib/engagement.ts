export type EngagementTarget = { type: 'creation' | 'album' | 'photo' | 'fitness'; id: string; parentId?: string }
export const VISITOR_KEY = 'xvyin-visitor-v1'
export const ANALYTICS_OPTOUT_KEY = 'xvyin-analytics-optout'
let temporaryVisitor = ''
export function visitorId(): string {
  if (typeof window === 'undefined') return ''
  try {
    const saved = localStorage.getItem(VISITOR_KEY)
    if (saved && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(saved)) return saved
    const id = temporaryVisitor ||= crypto.randomUUID()
    localStorage.setItem(VISITOR_KEY, id)
    return id
  } catch { return temporaryVisitor ||= crypto.randomUUID() }
}
export function analyticsAllowed(): boolean {
  if (typeof window === 'undefined') return false
  if (navigator.doNotTrack === '1' || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return false
  try { return localStorage.getItem(ANALYTICS_OPTOUT_KEY) !== '1' } catch { return false }
}
export function setAnalyticsAllowed(enabled: boolean): void {
  try { localStorage.setItem(ANALYTICS_OPTOUT_KEY, enabled ? '0' : '1') } catch { /* Disabled storage keeps collection off. */ }
  window.dispatchEvent(new Event('xvyin-privacy-change'))
}
export function targetKey(target: EngagementTarget): string { return `${target.type}/${target.parentId || ''}/${target.id}` }
/** Accumulate monotonic foreground time, excluding hidden tabs, blur, and clock jumps. */
export class ForegroundClock {
  private accumulated = 0
  private since: number | null = null
  constructor(private readonly clock: () => number) {}
  setActive(active: boolean): void {
    const now = this.clock()
    if (this.since !== null) this.accumulated += Math.max(0, now - this.since)
    this.since = active ? now : null
  }
  milliseconds(): number {
    return Math.min(86_400_000, Math.floor(this.accumulated + (this.since === null ? 0 : Math.max(0, this.clock() - this.since))))
  }
}
