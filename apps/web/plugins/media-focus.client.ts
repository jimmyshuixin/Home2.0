import { MediaFocusManager } from '~/lib/media-focus'
export default defineNuxtPlugin(() => {
  const focus = new MediaFocusManager()
  document.addEventListener('play', (event) => { if (event.target instanceof HTMLMediaElement) focus.activate(event.target) }, true)
  for (const name of ['ended', 'error']) document.addEventListener(name, (event) => { if (event.target instanceof HTMLMediaElement) focus.release(event.target) }, true)
  return { provide: { mediaFocus: focus } }
})
