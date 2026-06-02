import './styles.css';

const themeButton = document.querySelector('[data-theme-toggle]');
const saved = localStorage.getItem('theme');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.classList.toggle('dark-mode', saved ? saved === 'dark' : prefersDark);

themeButton?.addEventListener('click', () => {
  const isDark = !document.documentElement.classList.contains('dark-mode');
  document.documentElement.classList.toggle('dark-mode', isDark);
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
});

const form = document.querySelector('[data-contact-form]');
const status = document.querySelector('[data-form-status]');

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!status) return;
  const formData = new FormData(form);
  status.textContent = '信件投递中...';
  status.className = 'form-status';
  try {
    const response = await fetch('https://email.xvyin.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: formData.get('name'),
        contact_value: formData.get('email'),
        contact_method: 'email',
        message: formData.get('message'),
      }),
    });
    if (!response.ok) throw new Error('send failed');
    form.reset();
    status.textContent = '信件已投入邮筒。';
    status.classList.add('success');
  } catch {
    status.textContent = '投递失败，请稍后再试。';
    status.classList.add('error');
  }
});
