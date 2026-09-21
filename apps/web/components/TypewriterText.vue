<script setup lang="ts">
const props = withDefaults(defineProps<{ text: string; delay?: number; interval?: number }>(), {
  delay: 0,
  interval: 70,
})
const characters = computed(() => Array.from(props.text))
</script>

<template>
  <span class="typewriter-text">
    <span class="typewriter-readable">{{ text }}</span>
    <span aria-hidden="true"><span
      v-for="(character, index) in characters"
      :key="index"
      class="typewriter-character"
      :style="{
        '--character-delay': `${delay + index * interval}ms`,
        '--caret-duration': `${index === characters.length - 1 ? 360 : interval}ms`,
      }"
    >{{ character }}</span></span>
  </span>
</template>

<style scoped>
/* Keep every glyph in normal flow from the first frame, including mobile wraps.
   CSS drives the reveal so slow or unavailable JavaScript cannot hide the copy. */
.typewriter-character {
  position: relative;
  opacity: 1;
  animation: typewriter-reveal 1ms linear var(--character-delay) both;
}
.typewriter-character::after {
  content: '';
  position: absolute;
  inset-inline-end: -.06em;
  top: .12em;
  height: .8em;
  width: max(1px, .018em);
  background: var(--green, #163b2d);
  opacity: 0;
  pointer-events: none;
  animation: typewriter-caret var(--caret-duration) steps(1, end) var(--character-delay);
}
.typewriter-readable {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
@keyframes typewriter-reveal {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes typewriter-caret {
  from { opacity: .65; }
  to { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .typewriter-character { animation: none; }
  .typewriter-character::after { display: none; animation: none; }
}
@media print {
  .typewriter-character { animation: none; }
  .typewriter-character::after { display: none; }
}
</style>
