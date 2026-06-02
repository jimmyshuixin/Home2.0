import { reactive } from 'vue';
import { siteConfig } from '../data/site';

export function useContact() {
  const contact = reactive({
    name: '',
    email: '',
    message: '',
    sending: false,
    status: '',
    statusType: '',
  });

  const submitContact = async () => {
    if (!contact.name.trim() || !contact.email.trim() || !contact.message.trim()) {
      contact.status = '请把姓名、邮箱和正文都写完整。';
      contact.statusType = 'error';
      return;
    }
    contact.sending = true;
    contact.status = '';
    contact.statusType = '';
    try {
      const response = await fetch(siteConfig.emailApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: contact.name.trim(),
          contact_value: contact.email.trim(),
          contact_method: 'email',
          message: contact.message.trim(),
        }),
      });
      if (!response.ok) throw new Error('Mail failed');
      contact.status = '信件已投入邮筒。';
      contact.statusType = 'success';
      contact.name = '';
      contact.email = '';
      contact.message = '';
    } catch {
      contact.status = '投递失败，请稍后再试。';
      contact.statusType = 'error';
    } finally {
      contact.sending = false;
    }
  };

  return { contact, submitContact };
}
