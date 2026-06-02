import { onMounted, onUnmounted, ref } from 'vue';

export function useScrollState() {
  const progress = ref(0);
  const showBackToTop = ref(false);
  const activeSection = ref('story');
  const isNavHidden = ref(false);
  let ticking = false;
  let lastScroll = 0;

  const sections = ['story', 'growth', 'life', 'tech', 'future', 'contact'];

  const update = () => {
    const top = window.scrollY || 0;
    const docHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    progress.value = docHeight > 0 ? top / docHeight : 0;
    showBackToTop.value = top > 500;
    isNavHidden.value = top > lastScroll && top > 220;
    lastScroll = Math.max(top, 0);

    const current = sections
      .map((id) => ({ id, top: document.getElementById(id)?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY }))
      .filter((section) => section.top < window.innerHeight * 0.42)
      .pop();
    if (current) activeSection.value = current.id;
    ticking = false;
  };

  const onScroll = () => {
    if (!ticking) {
      window.requestAnimationFrame(update);
      ticking = true;
    }
  };

  const scrollTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const scrollToTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });

  onMounted(() => {
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
  });
  onUnmounted(() => window.removeEventListener('scroll', onScroll));

  return { progress, showBackToTop, activeSection, isNavHidden, scrollTo, scrollToTop };
}
