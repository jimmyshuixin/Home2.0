<script setup>
import { computed, onMounted, ref } from "vue";
import { BookOpen, Palette } from "@lucide/vue";
import JournalBook from "./components/JournalBook.vue";
import StudioCanvas from "./components/StudioCanvas.vue";
import { seedPages } from "./data/seedPages";
import { createPage, fetchPages, readCachedPages, runtimePort, writeCachedPages } from "./services/api";

const mode = ref(window.location.hash === "#studio" ? "studio" : "read");
const savedPages = ref([]);
const status = ref("正在翻开手账...");

const pages = computed(() => [...seedPages, ...savedPages.value]);

onMounted(async () => {
  try {
    const payload = await fetchPages();
    savedPages.value = payload.pages || [];
    status.value = "后端已连接";
  } catch {
    savedPages.value = readCachedPages();
    status.value = "正在使用本地草稿";
  }
});

function setMode(nextMode) {
  mode.value = nextMode;
  window.history.replaceState(null, "", nextMode === "studio" ? "#studio" : "#home");
}

async function handleSave(page) {
  try {
    const payload = await createPage(page);
    savedPages.value = [payload.page, ...savedPages.value];
    status.value = "新手账已经贴进书里";
  } catch {
    const fallbackPage = {
      ...page,
      id: runtimePort.createId(),
      createdAt: new Date().toISOString()
    };
    savedPages.value = [fallbackPage, ...savedPages.value];
    writeCachedPages(savedPages.value);
    status.value = "后端离线，已先存成本地草稿";
  }
  setMode("read");
}
</script>

<template>
  <main class="app-shell" :class="'mode-' + mode">
    <div class="desk-noise" aria-hidden="true"></div>

    <header class="topline" aria-label="Home2.0 navigation">
      <a class="brand-mark" href="#home" aria-label="Home2.0">
        <span class="brand-stitch">Home</span>
        <strong>2.0</strong>
      </a>

      <nav class="ribbon-nav" aria-label="主要模式">
        <button :class="{ active: mode === 'read' }" type="button" @click="setMode('read')">
          <BookOpen :size="18" stroke-width="2.3" />
          阅读
        </button>
        <button :class="{ active: mode === 'studio' }" type="button" @click="setMode('studio')">
          <Palette :size="18" stroke-width="2.3" />
          画板
        </button>
      </nav>
    </header>

    <p class="live-status" aria-live="polite">{{ status }}</p>

    <JournalBook v-if="mode === 'read'" id="home" :pages="pages" @open-studio="setMode('studio')" />
    <StudioCanvas v-else class="studio-focus" @save-page="handleSave" @close="setMode('read')" />
  </main>
</template>
