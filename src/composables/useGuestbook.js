import { onMounted, reactive, ref } from 'vue';
import { siteConfig } from '../data/site';

const demoMessages = [
  { name: '小鲸鱼', message: '很喜欢你的首页！', createdAt: '2025-05-20' },
  { name: 'Galaxy', message: '一起加油呀！', createdAt: '2025-05-18' },
  { name: '枝桃酥', message: '你拍的照片好有故事感。', createdAt: '2025-05-16' },
  { name: 'Sakura', message: '未来可期，保持热爱！', createdAt: '2025-05-12' },
];

export function useGuestbook() {
  const guestbook = reactive({
    messages: demoMessages,
    isSubmitting: false,
    newName: '',
    newEmail: '',
    newMessage: '',
    status: { type: '', message: '' },
  });
  const activeNotes = ref([]);

  const syncHeroNotes = (source = demoMessages) => {
    activeNotes.value = source.slice(0, 4).map((note, index) => ({
      id: `${note.name}-${index}`,
      ...note,
      style: {
        '--note-rotate': ['-4deg', '5deg', '-6deg', '4deg'][index] || '0deg',
      },
    }));
  };

  const fetchMessages = async () => {
    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 5000);
      const response = await fetch(siteConfig.guestbookApiUrl, { signal: controller.signal });
      window.clearTimeout(timeoutId);
      if (!response.ok) throw new Error('Guestbook unavailable');
      const messages = await response.json();
      if (Array.isArray(messages) && messages.length) {
        guestbook.messages = messages;
        syncHeroNotes(messages);
      }
    } catch {
      syncHeroNotes(demoMessages);
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
      guestbook.newEmail = '';
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
    fetchMessages();
  });

  return { guestbook, activeNotes, submitGuestbook };
}
