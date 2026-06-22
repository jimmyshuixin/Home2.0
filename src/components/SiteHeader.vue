<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Code2,
  Menu,
  MessagesSquare,
  Moon,
  Sparkles,
  Sun,
  X,
} from 'lucide-vue-next';
import { navItems, siteConfig } from '../data/site';

const props = defineProps({
  activeSection: { type: String, required: true },
  isDark: { type: Boolean, required: true },
  isHidden: { type: Boolean, required: true },
});

const emit = defineEmits(['scroll-to', 'toggle-theme']);
const isDrawerOpen = ref(false);
const isDouyinOpen = ref(false);

const icons = { Code2, MessagesSquare, Sparkles };

const closeDrawer = () => {
  isDrawerOpen.value = false;
};

const closeDouyin = () => {
  isDouyinOpen.value = false;
};

const go = (id) => {
  emit('scroll-to', id);
  closeDrawer();
};

const handleEscape = (event) => {
  if (event.key !== 'Escape') return;
  closeDrawer();
  closeDouyin();
};

watch([isDrawerOpen, isDouyinOpen], ([drawerOpen, douyinOpen]) => {
  document.body.style.overflow = drawerOpen || douyinOpen ? 'hidden' : '';
});

onMounted(() => window.addEventListener('keydown', handleEscape));

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleEscape);
  document.body.style.overflow = '';
});
</script>

<template>
  <header class="site-header" :class="{ 'site-header--hidden': props.isHidden }">
    <div class="reading-progress" aria-hidden="true"></div>
    <nav class="site-nav" aria-label="主导航">
      <button class="icon-button mobile-only" type="button" aria-label="打开菜单" @click="isDrawerOpen = true">
        <Menu :size="22" />
      </button>

      <button class="brand-mark" type="button" @click="go('hero')" aria-label="回到顶部">
        <span class="brand-wordmark" aria-hidden="true">
          <strong>{{ siteConfig.name }}</strong>
          <small>{{ siteConfig.englishName }}</small>
        </span>
      </button>

      <div class="nav-links desktop-only">
        <button
          v-for="item in navItems"
          :key="item.id"
          type="button"
      :class="{ active: props.activeSection === item.id }"
          @click="go(item.id)"
        >
          {{ item.label }}
        </button>
      </div>

      <div class="header-actions">
        <div class="douyin-menu desktop-only">
          <button
            class="icon-button"
            type="button"
            aria-label="查看抖音二维码"
            aria-describedby="douyin-hover-label"
            @click="isDouyinOpen = true"
          >
            <span class="douyin-mark" aria-hidden="true">抖</span>
          </button>
          <div class="douyin-popover" role="tooltip">
            <img src="/content/social/douyin-qr.jpg" alt="虚宁的抖音二维码" width="1313" height="1408" loading="lazy" decoding="async" />
            <strong id="douyin-hover-label">抖音 · 虚宁</strong>
            <span>扫码关注 tidingjinluo</span>
          </div>
        </div>
        <button
          class="icon-button mobile-only"
          type="button"
          aria-label="查看抖音二维码"
          @click="isDouyinOpen = true"
        >
          <span class="douyin-mark" aria-hidden="true">抖</span>
        </button>
        <button class="icon-button" type="button" :aria-label="isDark ? '切换到浅色模式' : '切换到深色模式'" @click="$emit('toggle-theme')">
          <Sun v-if="props.isDark" :size="21" />
          <Moon v-else :size="21" />
        </button>
      </div>
    </nav>
  </header>

  <Transition name="fade">
    <div v-if="isDouyinOpen" class="modal-backdrop douyin-modal-backdrop" @click.self="closeDouyin">
      <section class="douyin-modal" role="dialog" aria-modal="true" aria-labelledby="douyin-modal-title">
        <button class="icon-button modal-close" type="button" aria-label="关闭抖音二维码" @click="closeDouyin">
          <X :size="22" />
        </button>
        <p>扫码关注</p>
        <h2 id="douyin-modal-title">虚宁的抖音</h2>
        <img src="/content/social/douyin-qr.jpg" alt="虚宁的抖音二维码" width="1313" height="1408" loading="lazy" decoding="async" />
        <span>抖音号：tidingjinluo</span>
      </section>
    </div>
  </Transition>

  <Transition name="drawer">
    <div v-if="isDrawerOpen" class="drawer-backdrop" @click.self="closeDrawer">
      <aside class="mobile-drawer" aria-label="移动端导航">
        <button class="icon-button drawer-close" type="button" aria-label="关闭菜单" @click="closeDrawer">
          <X :size="22" />
        </button>
        <div class="drawer-profile">
          <img src="/content/visuals/field-portrait.webp" alt="虚宁头像" width="1100" height="1100" loading="lazy" decoding="async" />
          <div>
            <strong>虚宁</strong>
            <p>记录成长，也记录热爱</p>
          </div>
        </div>
        <div class="drawer-links">
          <button
            v-for="item in navItems"
            :key="item.id"
            type="button"
            :class="{ active: props.activeSection === item.id }"
            @click="go(item.id)"
          >
            <component :is="icons[item.icon]" :size="22" />
            <span>{{ item.label }}</span>
          </button>
        </div>
        <button class="drawer-mode" type="button" @click="$emit('toggle-theme')">
          <Moon :size="20" />
          <span>深色模式</span>
          <span class="switch" :class="{ on: props.isDark }"></span>
        </button>
        <a class="drawer-ai" href="/deepseek.html">
          <MessagesSquare :size="20" />
          <span>AI 助手</span>
          <small>随时呼唤，保持安静</small>
        </a>
      </aside>
    </div>
  </Transition>
</template>
