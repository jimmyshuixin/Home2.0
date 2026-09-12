export class MediaFocusManager {
  private active: HTMLMediaElement | null = null
  activate(media: HTMLMediaElement): void {
    if (this.active && this.active !== media) this.active.pause()
    this.active = media
  }
  release(media: HTMLMediaElement): void { if (this.active === media) this.active = null }
  stop(): void { this.active?.pause(); this.active = null }
}
