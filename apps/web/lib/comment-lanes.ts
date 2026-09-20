export type CommentLaneState<T> = {
  tracks: Array<{ comment: T; entering: boolean }>
  nextComment: number
  nextTrack: number
}

/** Show real content immediately, before the first timed replacement. */
export function createCommentLanes<T>(comments: readonly T[]): CommentLaneState<T> {
  return {
    tracks: comments.slice(0, 3).map(comment => ({ comment, entering: false })),
    nextComment: 3,
    nextTrack: 0,
  }
}

/** Replace one lane without mutating the API result or the previous visible state. */
export function advanceCommentLanes<T>(comments: readonly T[], state: CommentLaneState<T>): CommentLaneState<T> {
  if (comments.length <= 3) return state
  const comment = comments[state.nextComment % comments.length]
  if (comment === undefined) return state
  return {
    tracks: state.tracks.map((track, index) => index === state.nextTrack ? { comment, entering: true } : track),
    nextComment: (state.nextComment + 1) % comments.length,
    nextTrack: (state.nextTrack + 1) % 3,
  }
}
