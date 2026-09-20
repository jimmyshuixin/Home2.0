/** Partition public comments into independent horizontal tracks, without synthetic content. */
export function createCommentLanes<T>(comments: readonly T[]): T[][] {
  const lanes: T[][] = Array.from({ length: Math.min(3, comments.length) }, () => [])
  comments.forEach((comment, index) => lanes[index % lanes.length]?.push(comment))
  return lanes
}

export type CommentLoop = { repetitions: number; cycleWidth: number; durationSeconds: number }

/** Two identical cycles cover the viewport throughout a full leftward translation. */
export function measureCommentLoop(viewportWidth: number, sequenceWidth: number, pixelsPerSecond = 26): CommentLoop {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || !Number.isFinite(sequenceWidth) || sequenceWidth <= 0) {
    return { repetitions: 1, cycleWidth: 0, durationSeconds: 0 }
  }
  const speed = Number.isFinite(pixelsPerSecond) && pixelsPerSecond > 0 ? pixelsPerSecond : 26
  const repetitions = Math.max(1, Math.ceil(viewportWidth / sequenceWidth))
  const cycleWidth = sequenceWidth * repetitions
  return { repetitions, cycleWidth, durationSeconds: cycleWidth / speed }
}
