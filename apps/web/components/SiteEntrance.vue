<script setup lang="ts">
const finished = useState<boolean>('site-entrance-finished', () => false)
const entrance = ref<HTMLElement | null>(null)
let fallback: ReturnType<typeof setTimeout> | undefined
let reducedMotion: MediaQueryList | undefined

function cleanup() {
  clearTimeout(fallback)
  fallback = undefined
  window.removeEventListener('pointerdown', dismiss, true)
  window.removeEventListener('keydown', dismiss, true)
  window.removeEventListener('wheel', dismiss, true)
  reducedMotion?.removeEventListener('change', onMotionChange)
}

function dismiss() {
  finished.value = true
  cleanup()
}

function onMotionChange(event: MediaQueryListEvent) {
  if (event.matches) dismiss()
}

onMounted(() => {
  if (finished.value) return
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  // CSS begins with the server-rendered page and may finish before hydration.
  if (reducedMotion.matches || !entrance.value || getComputedStyle(entrance.value).visibility === 'hidden') {
    dismiss()
    return
  }
  window.addEventListener('pointerdown', dismiss, { capture: true, passive: true })
  window.addEventListener('keydown', dismiss, true)
  window.addEventListener('wheel', dismiss, { capture: true, passive: true })
  reducedMotion.addEventListener('change', onMotionChange)
  // Also remove the decoration if animations are disabled or an event is missed.
  fallback = setTimeout(dismiss, 1500)
})

onBeforeUnmount(dismiss)
</script>

<template>
  <div v-if="!finished" ref="entrance" class="site-entrance" aria-hidden="true" @animationend.self="dismiss">
    <div class="site-entrance__signature">
      <span class="site-entrance__ink"></span>
      <span class="site-entrance__name">虚宁</span>
      <span class="site-entrance__domain">xvyin.com</span>
      <span class="site-entrance__caption">正在展开…</span>
    </div>
  </div>
</template>

<style scoped>
.site-entrance {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: #f7f3e9;
  color: #111;
  pointer-events: none;
  user-select: none;
  /* The overlay dismisses even when JavaScript has not hydrated. */
  animation: entrance-dismiss 350ms ease 850ms both;
}

.site-entrance__signature {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  isolation: isolate;
  font-family: var(--serif, 'Songti SC', 'SimSun', serif);
}

.site-entrance__ink {
  position: absolute;
  z-index: -1;
  top: -40px;
  width: 188px;
  height: 166px;
}

.site-entrance__ink::before,
.site-entrance__ink::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 1px solid #163b2d20;
  border-top-color: #163b2d08;
  border-right-color: transparent;
  border-radius: 48% 52% 45% 55%;
  transform: rotate(-16deg);
  animation: entrance-ink 850ms ease-out both;
}

.site-entrance__ink::after {
  inset: 8px -5px -4px 7px;
  border-color: #163b2d0d;
  border-bottom-color: transparent;
  animation-delay: 100ms;
}

.site-entrance__name {
  font: 400 clamp(72px, 18vw, 88px)/1.2 XuBrush, var(--serif, serif);
  letter-spacing: .06em;
}

.site-entrance__domain {
  margin-top: 15px;
  color: #163b2d;
  font: 400 13px/1.5 Georgia, 'Times New Roman', serif;
  letter-spacing: .22em;
}

.site-entrance__caption {
  margin-top: 35px;
  color: #595750;
  font-size: 12px;
  line-height: 1.8;
  letter-spacing: .18em;
}

@keyframes entrance-ink {
  from { opacity: 0; transform: scale(.8) rotate(-22deg); }
  to { opacity: 1; transform: scale(1) rotate(-16deg); }
}

@keyframes entrance-dismiss {
  from { opacity: 1; visibility: visible; }
  to { opacity: 0; visibility: hidden; }
}

@media (prefers-reduced-motion: reduce) {
  .site-entrance { display: none; animation: none; }
  .site-entrance__ink::before,
  .site-entrance__ink::after { animation: none; }
}
</style>
