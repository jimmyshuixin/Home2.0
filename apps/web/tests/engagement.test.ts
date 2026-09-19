import { describe, expect, it } from 'vitest'
import { ForegroundClock, targetKey } from '../lib/engagement'
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
