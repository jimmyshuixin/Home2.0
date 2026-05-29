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
const bookmarkItems = computed(() =>
  [
    { title: "My Journal", index: 0 },
    { title: "目录", index: 1 },
    { title: "窗边的早晨", index: 2 },
    { title: "散步路线", index: 3 }
  ].filter((item) => item.index < total.value)
);
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
    <aside class="bookmark-stack" aria-label="目录书签">
      <button
        v-for="item in bookmarkItems"
        :key="item.title"
        type="button"
        :class="{ active: item.index === spreadStart || item.index === spreadStart + 1 }"
        @click="jumpTo(item.index)"
      >
        <span>{{ item.title }}</span>
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

    <button class="studio-ticket reader-studio-ticket" type="button" @click="$emit('open-studio')">
      <PenLine :size="18" />
      写一页
    </button>
  </section>
</template>
