import { createHash } from 'node:crypto';

// Fixed protocol parameters from the public biliup TV QR implementation.
// Only transport outcomes are printed. Never print QR URLs, codes or response bodies.
const form = new URLSearchParams({ appkey: '4409e2ce8ffd12b8', local_id: '0', ts: String(Math.floor(Date.now() / 1000)) });
form.set('sign', createHash('md5').update(form.toString() + '59b43e04ad6965f34319062b478f83dd').digest('hex'));
for (const [name, url, options] of [
  ['qr', 'https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code', { method: 'POST', body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
  ['profile', 'https://api.bilibili.com/x/web-interface/card?mid=520237303', {}],
]) {
  try {
    const response = await fetch(url, { ...options, headers: { ...options.headers, referer: 'https://www.bilibili.com/', 'user-agent': 'Mozilla/5.0' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    let value; try { value = await response.json(); } catch {}
    console.log(JSON.stringify({ name, http: response.status, code: value?.code ?? null, validData: !!value?.data, hasQr: typeof value?.data?.url === 'string' }));
  } catch { console.log(JSON.stringify({ name, error: 'network-unavailable' })); }
}
