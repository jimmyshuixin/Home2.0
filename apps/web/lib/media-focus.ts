export class MediaFocusManager {
  private active: HTMLMediaElement | null = null
  private listeners = new Set<(media: HTMLMediaElement) => void>()
  activate(media: HTMLMediaElement): void {
    if (this.active && this.active !== media) this.active.pause()
    this.active = media
    for (const listener of this.listeners) listener(media)
  }
  onActivate(listener: (media: HTMLMediaElement) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  release(media: HTMLMediaElement): void { if (this.active === media) this.active = null }
  stop(): void { this.active?.pause(); this.active = null }
}
