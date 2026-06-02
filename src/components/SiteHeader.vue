<script setup>
import { ref, watch } from 'vue';
import {
  Code2,
  Heart,
  Menu,
  MessagesSquare,
  Moon,
  Rocket,
  Route,
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

const icons = { Code2, Heart, MessagesSquare, Rocket, Route, Sparkles };

const closeDrawer = () => {
  isDrawerOpen.value = false;
};

const go = (id) => {
  emit('scroll-to', id);
  closeDrawer();
};

watch(isDrawerOpen, (open) => {
  document.body.style.overflow = open ? 'hidden' : '';
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
        <span class="brand-seal">虚</span>
        <span>
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

      <button class="icon-button" type="button" :aria-label="isDark ? '切换到浅色模式' : '切换到深色模式'" @click="$emit('toggle-theme')">
        <Sun v-if="props.isDark" :size="21" />
        <Moon v-else :size="21" />
      </button>
    </nav>
  </header>

  <Transition name="drawer">
    <div v-if="isDrawerOpen" class="drawer-backdrop" @click.self="closeDrawer">
      <aside class="mobile-drawer" aria-label="移动端导航">
        <button class="icon-button drawer-close" type="button" aria-label="关闭菜单" @click="closeDrawer">
          <X :size="22" />
        </button>
        <div class="drawer-profile">
          <img src="/content/visuals/field-portrait.png" alt="虚宁头像" />
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
