import { describe, expect, it } from 'vitest'
import { createCommentLanes, measureCommentLoop } from '../lib/comment-lanes'

const comments = (count: number) => Array.from({ length: count }, (_, index) => ({ id: String(index), body: `Real comment ${index}` }))
type Measurement = [viewport: number, sequence: number]
const loopMeasurements: Measurement[] = [[280, 80], [552, 190.25], [760, 42], [552, 4200]]
const invalidMeasurements: Measurement[] = [[0, 40], [300, 0], [300, NaN], [Infinity, 40], [-1, 40]]
const resizedMeasurements: Measurement[] = [[280, 180], [552, 180], [552, 231.75]]

describe('continuous public comment lanes', () => {
  it.each([0, 1, 2, 3, 4, 5, 12])('distributes %i public comments without dropping, changing, or inventing content', count => {
    const published = comments(count)
    const before = JSON.stringify(published)
    const lanes = createCommentLanes(published)
    expect(lanes).toHaveLength(Math.min(3, count))
    expect(lanes.flat()).toHaveLength(count)
    expect(new Set(lanes.flat().map(comment => comment.id)).size).toBe(count)
    expect(lanes.map(lane => lane[0])).toEqual(published.slice(0, 3))
    for (const lane of lanes) for (const comment of lane) expect(published).toContain(comment)
    expect(JSON.stringify(published)).toBe(before)
  })

  it('keeps subsequent messages in their own lane, rather than periodically replacing visible rows', () => {
    const lanes = createCommentLanes(comments(8))
    expect(lanes.map(lane => lane.map(comment => comment.id))).toEqual([['0', '3', '6'], ['1', '4', '7'], ['2', '5']])
  })

  it.each(loopMeasurements)('fills a %ipx viewport with a %ipx sequence and preserves a seamless loop', (viewport, sequence) => {
    const loop = measureCommentLoop(viewport, sequence)
    expect(loop.cycleWidth).toBeGreaterThanOrEqual(viewport)
    expect(loop.cycleWidth).toBe(sequence * loop.repetitions)
    expect(loop.cycleWidth / loop.durationSeconds).toBeCloseTo(26)
    // The second copy covers the right edge even at the last frame of the first cycle.
    for (const progress of [0, .25, .5, .75, .999999, 1]) {
      expect(2 * loop.cycleWidth - progress * loop.cycleWidth).toBeGreaterThanOrEqual(viewport)
    }
    expect(loop.repetitions - 1).toBeLessThan(viewport / sequence)
  })

  it('waits for a measurable layout instead of starting an invalid or zero-duration animation', () => {
    for (const [viewport, sequence] of invalidMeasurements) {
      expect(measureCommentLoop(viewport, sequence)).toEqual({ repetitions: 1, cycleWidth: 0, durationSeconds: 0 })
    }
  })

  it('preserves pixel speed after responsive resizing or a font changes sequence width', () => {
    for (const [viewport, sequence] of resizedMeasurements) {
      const loop = measureCommentLoop(viewport, sequence, 30)
      expect(loop.cycleWidth / loop.durationSeconds).toBeCloseTo(30)
    }
    expect(measureCommentLoop(280, 180, 0).durationSeconds).toBeCloseTo(360 / 26)
  })
})
