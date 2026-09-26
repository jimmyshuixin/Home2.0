/** Native media pause directly; cross-origin players pause by removing their iframe. */
export interface MediaFocusTarget { pause(): void }
export class MediaFocusManager {
  private active: MediaFocusTarget | null = null
  private listeners = new Set<(media: MediaFocusTarget) => void>()
  activate(media: MediaFocusTarget): void {
    if (this.active && this.active !== media) this.active.pause()
    this.active = media
    for (const listener of this.listeners) listener(media)
  }
  onActivate(listener: (media: MediaFocusTarget) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  release(media: MediaFocusTarget): void { if (this.active === media) this.active = null }
  stop(): void { this.active?.pause(); this.active = null }
}
