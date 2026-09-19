import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyticsAllowed, ANALYTICS_OPTOUT_KEY, ForegroundClock, targetKey } from '../lib/engagement'

describe('default background analytics', () => {
  afterEach(() => vi.unstubAllGlobals())
  function browser(preference: string | null = null, signals: { doNotTrack?: string; globalPrivacyControl?: boolean } = {}) {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', signals)
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === ANALYTICS_OPTOUT_KEY ? preference : null })
  }
  it('starts enabled for visitors without a saved opt-out', () => {
    browser(); expect(analyticsAllowed()).toBe(true)
  })
  it('continues respecting an existing opt-out', () => {
    browser('1'); expect(analyticsAllowed()).toBe(false)
  })
  it.each([{ doNotTrack: '1' }, { globalPrivacyControl: true }])('respects browser privacy signals even after a previous opt-in: %o', signals => {
    browser('0', signals); expect(analyticsAllowed()).toBe(false)
  })
  it('keeps analytics off when browser storage cannot be read', () => {
    browser(); vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Storage unavailable') } })
    expect(analyticsAllowed()).toBe(false)
  })
})
describe('foreground engagement time', () => {
  it('excludes hidden and unfocused intervals and remains cumulative on return', () => {
    let now = 0; const clock = new ForegroundClock(() => now)
    clock.setActive(true); now = 12000; expect(clock.milliseconds()).toBe(12000)
    clock.setActive(false); now = 72000; expect(clock.milliseconds()).toBe(12000)
    clock.setActive(true); now = 75000; expect(clock.milliseconds()).toBe(15000)
    clock.setActive(false); expect(clock.milliseconds()).toBe(15000)
  })
  it('bounds invalid negative elapsed and prolonged sessions', () => {
    let now = 20; const clock = new ForegroundClock(() => now)
    clock.setActive(true); now = 10; expect(clock.milliseconds()).toBe(0)
    now = 100_000_000; expect(clock.milliseconds()).toBe(86_400_000)
  })
  it('scopes photo state to the album as well as the photo identifier', () => {
    expect(targetKey({ type: 'photo', id: 'same', parentId: 'one' })).not.toBe(targetKey({ type: 'photo', id: 'same', parentId: 'two' }))
  })
})
