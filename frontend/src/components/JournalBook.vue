<script setup>
import { computed, ref } from "vue";
import { ChevronLeft, ChevronRight, PenLine } from "@lucide/vue";
import BookPage from "./BookPage.vue";

const props = defineProps({
  pages: {
    type: Array,
    required: true
  }
});

defineEmits(["open-studio"]);

const spreadStart = ref(2);
const turning = ref(false);

const total = computed(() => props.pages.length);
const leftPage = computed(() => props.pages[spreadStart.value]);
const rightPage = computed(() => props.pages[spreadStart.value + 1]);
const mobilePage = computed(() => (leftPage.value?.kind === "toc" ? rightPage.value || leftPage.value : leftPage.value));
const edgeTabs = ["About Me", "Daydreams", "Travels", "Little Things"];

function flip(direction) {
  const next = spreadStart.value + direction * 2;
  if (next < 0 || next >= total.value) return;
  turning.value = true;
  window.setTimeout(() => {
    spreadStart.value = next;
    turning.value = false;
  }, 220);
}

function jumpTo(index) {
  spreadStart.value = index % 2 === 0 ? index : index - 1;
}
</script>

<template>
  <section class="reader-stage" aria-label="手账阅读器">
    <p class="scene-note scene-note-left">desktop<br />open book<br />reading view</p>

    <aside class="bookmark-stack" aria-label="目录书签">
      <button
        v-for="(page, index) in pages.slice(0, 5)"
        :key="page.id"
        type="button"
        :class="{ active: index === spreadStart || index === spreadStart + 1 }"
        @click="jumpTo(index)"
      >
        <span>{{ page.title }}</span>
      </button>
    </aside>

    <div class="book-wrap" :class="{ turning }">
      <div class="book-cover-cloth" aria-hidden="true"></div>
      <div class="pressed-leaf" aria-hidden="true"></div>

      <button
        class="turn-button turn-left"
        type="button"
        aria-label="上一页"
        :disabled="spreadStart === 0"
        @click="flip(-1)"
      >
        <ChevronLeft :size="22" />
      </button>

      <article class="book-spread" :class="{ 'has-right-page': rightPage }">
        <BookPage :page="leftPage" side="left" />
        <div class="book-gutter" aria-hidden="true"></div>
        <BookPage v-if="rightPage" :page="rightPage" side="right" />
      </article>

      <div class="edge-tabs" aria-hidden="true">
        <span v-for="tab in edgeTabs" :key="tab">{{ tab }}</span>
      </div>

      <button
        class="turn-button turn-right"
        type="button"
        aria-label="下一页"
        :disabled="spreadStart + 2 >= total"
        @click="flip(1)"
      >
        <ChevronRight :size="22" />
      </button>
    </div>

    <aside class="mobile-side" aria-label="移动端单页预览">
      <div class="phone-preview">
        <div class="phone-speaker" aria-hidden="true"></div>
        <BookPage :page="mobilePage" side="mobile" compact />
        <div class="phone-controls" aria-hidden="true">
          <span>‹</span>
          <span>{{ spreadStart + 1 }} / {{ total }}</span>
          <span>›</span>
        </div>
      </div>
      <p class="scene-note scene-note-right">mobile<br />one page<br />view</p>
      <div class="washi-roll" aria-hidden="true"></div>
      <button class="studio-ticket" type="button" @click="$emit('open-studio')">
        <PenLine :size="18" />
        写一页
      </button>
    </aside>
  </section>
</template>
