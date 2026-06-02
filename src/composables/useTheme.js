import { onMounted, ref, watch } from 'vue';

export function useTheme() {
  const isDark = ref(false);

  const applyTheme = () => {
    document.documentElement.classList.toggle('dark-mode', isDark.value);
  };

  const toggleTheme = () => {
    isDark.value = !isDark.value;
    localStorage.setItem('theme', isDark.value ? 'dark' : 'light');
  };

  onMounted(() => {
    const saved = localStorage.getItem('theme');
    isDark.value = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme();
  });

  watch(isDark, applyTheme);

  return { isDark, toggleTheme };
}
