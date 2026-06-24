export function createMusicLoginPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QQ Music Worker Login</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1020; color: #eef2ff; }
    main { width: min(92vw, 440px); padding: 28px; border: 1px solid #29324d; border-radius: 20px; background: #121a2f; box-shadow: 0 24px 80px #0008; }
    h1 { margin: 0 0 8px; font-size: 1.55rem; }
    p { color: #aeb9d6; line-height: 1.55; }
    .status { margin: 20px 0; padding: 14px; border-radius: 12px; background: #0b1224; }
    .status strong { display: block; color: #fff; }
    .status small { color: #8fa0c7; }
    .admin-token { width: 100%; box-sizing: border-box; margin: 8px 0 14px; border: 1px solid #34415f; border-radius: 10px; padding: 11px 13px; background: #0b1224; color: #eef2ff; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    button { border: 0; border-radius: 999px; padding: 11px 18px; cursor: pointer; font-weight: 700; background: #7c9cff; color: #081126; }
    button.secondary { background: #263451; color: #dfe7ff; }
    button:disabled { cursor: wait; opacity: .55; }
    #qr { display: none; width: 240px; max-width: 100%; margin: 22px auto 8px; border-radius: 12px; background: #fff; padding: 10px; }
    #message { min-height: 24px; color: #c8d3f5; }
    code { color: #9eb5ff; }
  </style>
</head>
<body>
  <main>
    <h1>QQ Music Worker Login</h1>
    <p>This page controls the single QQ Music account used by the API. The public site never receives the account cookie.</p>
    <div class="status">
      <strong id="status">Checking Worker session...</strong>
      <small id="expires"></small>
    </div>
    <input id="admin-token" class="admin-token" type="password" autocomplete="current-password" placeholder="MUSIC_ADMIN_TOKEN">
    <div class="actions">
      <button id="login" type="button">Create login QR</button>
      <button id="logout" class="secondary" type="button">Clear Worker session</button>
    </div>
    <img id="qr" alt="QQ login QR code">
    <p id="message"></p>
    <p><small>API endpoint: <code>?server=tencent&amp;type=playlist&amp;id=...</code></small></p>
  </main>
  <script>
    const elements = {
      status: document.querySelector('#status'),
      expires: document.querySelector('#expires'),
      adminToken: document.querySelector('#admin-token'),
      login: document.querySelector('#login'),
      logout: document.querySelector('#logout'),
      qr: document.querySelector('#qr'),
      message: document.querySelector('#message'),
    };
    let pollTimer = 0;
    let loginState = '';
    let loginKey = '';

    function adminToken() {
      return elements.adminToken.value.trim() || sessionStorage.getItem('music-admin-token') || '';
    }

    async function api(path, options = {}) {
      const token = adminToken();
      if (token) sessionStorage.setItem('music-admin-token', token);
      const response = await fetch(path, {
        ...options,
        headers: {
          ...(token ? { 'X-Music-Admin-Token': token } : {}),
          ...(options.headers || {}),
        },
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 403) throw new Error('Enter a valid MUSIC_ADMIN_TOKEN above.');
      if (!response.ok) throw new Error(data.error || data.message || 'Request failed');
      return data;
    }

    async function refreshStatus() {
      try {
        const data = await api('/session/status?server=tencent');
        elements.status.textContent = data.ok ? 'Worker session is active' : 'Worker session is not active';
        elements.expires.textContent = data.expiresAt ? 'Stored until ' + new Date(data.expiresAt).toLocaleString() : '';
      } catch {
        elements.status.textContent = 'Worker session is not active';
        elements.expires.textContent = '';
      }
    }

    async function poll() {
      try {
        const data = await api('/login/qr/check?server=tencent&state=' + encodeURIComponent(loginState) + '&key=' + encodeURIComponent(loginKey));
        elements.message.textContent = data.message || 'Waiting for confirmation...';
        if (Number(data.code) === 803) {
          elements.qr.style.display = 'none';
          elements.login.disabled = false;
          await refreshStatus();
          return;
        }
        if (Number(data.code) === 800) {
          elements.login.disabled = false;
          return;
        }
        pollTimer = window.setTimeout(poll, 2400);
      } catch (error) {
        elements.message.textContent = error.message;
        elements.login.disabled = false;
      }
    }

    elements.login.addEventListener('click', async () => {
      window.clearTimeout(pollTimer);
      elements.login.disabled = true;
      elements.message.textContent = 'Creating QR code...';
      try {
        const data = await api('/login/qr?server=tencent');
        loginState = data.state || '';
        loginKey = data.key || data.qrsig || '';
        elements.qr.src = data.qrimg || '';
        elements.qr.style.display = data.qrimg ? 'block' : 'none';
        elements.message.textContent = data.message || 'Scan with QQ and confirm login.';
        pollTimer = window.setTimeout(poll, 1200);
      } catch (error) {
        elements.message.textContent = error.message;
        elements.login.disabled = false;
      }
    });

    elements.logout.addEventListener('click', async () => {
      try {
        await api('/session/logout', { method: 'POST' });
        elements.message.textContent = 'Worker session cleared.';
        await refreshStatus();
      } catch (error) {
        elements.message.textContent = error.message;
      }
    });

    refreshStatus();
  </script>
</body>
</html>`;
}
