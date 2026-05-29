<script setup>
import { computed } from "vue";

const props = defineProps({
  page: {
    type: Object,
    required: true
  },
  side: {
    type: String,
    required: true
  }
});

const tapeLabels = {
  sky: "sky tape",
  coral: "coral tape"
};

const pageNumber = computed(() => {
  if (props.page.kind === "cover") return "cover";
  if (props.page.kind === "toc") return "contents";
  return props.page.date;
});
</script>

<template>
  <section class="book-page" :class="['page-' + side, 'kind-' + (page.kind || 'entry')]">
    <div class="page-pin" aria-hidden="true"></div>
    <div class="page-meta">
      <span>{{ pageNumber }}</span>
      <span>{{ page.mood }}</span>
    </div>

    <template v-if="page.kind === 'cover'">
      <div class="cover-composition">
        <span class="cover-tape cover-tape-a"></span>
        <img :src="page.image" alt="" class="cover-photo" />
        <h1>{{ page.title }}</h1>
        <p>{{ page.excerpt }}</p>
        <span class="cover-seal">handmade days</span>
      </div>
    </template>

    <template v-else-if="page.kind === 'toc'">
      <h2>{{ page.title }}</h2>
      <ol class="toc-list">
        <li>日常小记 <span>p.03</span></li>
        <li>走走停停 <span>p.04</span></li>
        <li>喜欢的瞬间 <span>p.05</span></li>
        <li>给未来的便签 <span>p.06</span></li>
      </ol>
      <p class="page-copy">{{ page.excerpt }}</p>
      <div class="bookmark-ribbon" aria-hidden="true"></div>
    </template>

    <template v-else>
      <h2>{{ page.title }}</h2>
      <p class="page-copy">{{ page.excerpt }}</p>

      <div v-if="page.image" class="taped-photo" :style="{ transform: 'rotate(3deg)' }">
        <span class="tape tape-one"></span>
        <span class="tape tape-two"></span>
        <img :src="page.image" alt="" />
      </div>

      <img v-if="page.drawing" class="drawing-layer" :src="page.drawing" alt="" />

      <div
        v-for="element in page.elements"
        :key="element.id"
        class="page-element"
        :class="'element-' + element.type"
        :style="{
          left: element.x + '%',
          top: element.y + '%',
          width: element.width + '%',
          transform: 'rotate(' + element.rotate + 'deg)'
        }"
      >
        <span v-if="element.type === 'tape'" :class="['tape-strip', element.color]">
          {{ tapeLabels[element.color] || "tape" }}
        </span>
        <img v-else-if="element.type === 'image'" :src="element.src" alt="" />
        <span v-else-if="element.type === 'sticker'" class="sticker-dot">{{ element.text }}</span>
        <span v-else>{{ element.text }}</span>
      </div>
    </template>
  </section>
</template>
