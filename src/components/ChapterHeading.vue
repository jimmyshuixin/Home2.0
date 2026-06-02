<script setup>
defineProps({
  number: { type: String, required: true },
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
  accent: { type: String, default: 'red' },
});
</script>

<template>
  <header class="chapter-heading" :class="`chapter-heading--${accent}`">
    <span>{{ number }}</span>
    <div>
      <h2>{{ title }}</h2>
      <p v-if="subtitle">{{ subtitle }}</p>
    </div>
  </header>
</template>
