import { describe, expect, it } from 'vitest'
import { advanceCommentLanes, createCommentLanes } from '../lib/comment-lanes'

const comments = (count: number) => Array.from({ length: count }, (_, index) => ({ id: String(index), body: `Real comment ${index}` }))

describe('readable public comment lanes', () => {
  it.each([0, 1, 2, 3])('shows all %i available comments immediately without synthetic rows or rotation', count => {
    const published = comments(count)
    const state = createCommentLanes(published)
    expect(state.tracks.map(track => track.comment)).toEqual(published)
    expect(state.tracks.every(track => !track.entering)).toBe(true)
    expect(advanceCommentLanes(published, state)).toBe(state)
  })

  it.each([4, 5, 12])('cycles through %i comments with one changing row, unique keys and no blank frame', count => {
    const published = comments(count)
    const inputBefore = JSON.stringify(published)
    let state = createCommentLanes(published)
    const seen = new Set(state.tracks.map(track => track.comment.id))
    for (let step = 0; step < count * 3; step++) {
      const previous = state
      const previousBefore = JSON.stringify(previous)
      state = advanceCommentLanes(published, state)
      expect(state.tracks).toHaveLength(3)
      expect(new Set(state.tracks.map(track => track.comment.id)).size).toBe(3)
      expect(state.tracks.filter((track, index) => track.comment.id !== previous.tracks[index]?.comment.id)).toHaveLength(1)
      expect(JSON.stringify(previous)).toBe(previousBefore)
      for (const track of state.tracks) {
        expect(published).toContain(track.comment)
        seen.add(track.comment.id)
      }
    }
    expect(seen.size).toBe(count)
    expect(JSON.stringify(published)).toBe(inputBefore)
  })

  it('resets to the new public response after a reload instead of keeping stale comments', () => {
    const before = comments(12)
    let state = advanceCommentLanes(before, createCommentLanes(before))
    const replacement = [{ id: 'approved-new', body: 'New public comment' }]
    state = createCommentLanes(replacement)
    expect(state.tracks.map(track => track.comment.id)).toEqual(['approved-new'])
    expect(advanceCommentLanes(replacement, state)).toBe(state)
  })
})
