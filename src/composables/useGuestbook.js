import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { siteConfig } from '../data/site';

const demoMessages = [
  { name: '小鲸鱼', message: '很喜欢你的首页！', createdAt: '2025-05-20' },
  { name: 'Galaxy', message: '一起加油呀！', createdAt: '2025-05-18' },
  { name: '枝桃酥', message: '你拍的照片好有故事感。', createdAt: '2025-05-16' },
  { name: 'Sakura', message: '未来可期，保持热爱！', createdAt: '2025-05-12' },
];

const scheduleIdleTask = (callback, delay = 1800) => {
  if (typeof window === 'undefined') return () => {};

  let idleId;
  const timeoutId = window.setTimeout(() => {
    if ('requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(() => {
        void callback();
      }, { timeout: 4000 });
      return;
    }

    void callback();
  }, delay);

  return () => {
    window.clearTimeout(timeoutId);
    if (idleId) window.cancelIdleCallback?.(idleId);
  };
};

export function useGuestbook() {
  const guestbook = reactive({
    messages: demoMessages,
    isSubmitting: false,
    newName: '',
    newMessage: '',
    status: { type: '', message: '' },
  });
  const activeNotes = ref([]);
  let refreshTimer;
  let cancelInitialFetch;

  const syncHeroNotes = (source = demoMessages) => {
    const notes = (Array.isArray(source) && source.length ? source : demoMessages).slice(0, 8);
    activeNotes.value = notes.map((note, index) => ({
      id: `${note.name}-${index}`,
      ...note,
      style: {
        '--danmaku-top': `${10 + (index % 5) * 16}%`,
        '--danmaku-delay': `${index * -3.8}s`,
        '--danmaku-duration': `${24 + (index % 4) * 4}s`,
        '--danmaku-alpha': index % 2 ? '0.72' : '0.86',
      },
    }));
  };

  const fetchMessages = async () => {
    if (document.visibilityState === 'hidden') return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(siteConfig.guestbookApiUrl, { signal: controller.signal });
      if (!response.ok) throw new Error('Guestbook unavailable');
      const messages = await response.json();
      if (Array.isArray(messages) && messages.length) {
        guestbook.messages = messages;
        syncHeroNotes(messages);
      }
    } catch {
      syncHeroNotes(demoMessages);
    } finally {
      window.clearTimeout(timeoutId);
    }
  };

  const submitGuestbook = async () => {
    const name = guestbook.newName.trim();
    const message = guestbook.newMessage.trim();
    if (!name || !message) {
      guestbook.status = { type: 'error', message: '请留下昵称和想说的话。' };
      return;
    }
    guestbook.isSubmitting = true;
    guestbook.status = { type: '', message: '' };
    try {
      const response = await fetch(siteConfig.guestbookApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, message }),
      });
      if (!response.ok) throw new Error('Submit failed');
      const newItem = { name, message, createdAt: new Date().toISOString().slice(0, 10) };
      guestbook.messages = [newItem, ...guestbook.messages];
      syncHeroNotes(guestbook.messages);
      guestbook.newName = '';
      guestbook.newMessage = '';
      guestbook.status = { type: 'success', message: '纸条已贴上，感谢你的到访。' };
    } catch {
      guestbook.status = { type: 'error', message: '暂时没有投递成功，请稍后重试。' };
    } finally {
      guestbook.isSubmitting = false;
    }
  };

  onMounted(() => {
    syncHeroNotes(demoMessages);
    cancelInitialFetch = scheduleIdleTask(() => {
      fetchMessages();
      refreshTimer = window.setInterval(fetchMessages, 60000);
    }, 2200);
  });

  onBeforeUnmount(() => {
    cancelInitialFetch?.();
    if (refreshTimer) window.clearInterval(refreshTimer);
  });

  return { guestbook, activeNotes, submitGuestbook };
}
