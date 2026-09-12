import { assert } from './errors';

/** QQ's web endpoint supports JSONP but does not permit cross-origin fetch.
 * This document runs in an opaque sandbox; its only outbound request is to QQ.
 * On supporting browsers COEP credentialless additionally strips credentials
 * from that cross-origin no-cors script. Isolation never relies on COEP alone. */
export function qqBrowserPage(request: Request, songmid: string, siteOrigin: string): Response {
  assert(['https://test.xvyin.com', 'https://xvyin.com'].includes(siteOrigin), 'MUSIC_NOT_CONFIGURED', 503, '音乐网站地址未配置');
  assert(/^[A-Za-z0-9]{1,80}$/u.test(songmid), 'MUSIC_UNAVAILABLE', 503, 'QQ 曲目标识无效');
  const nonce = new URL(request.url).searchParams.get('nonce');
  assert(nonce && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(nonce), 'INVALID_NONCE', 400, '音乐请求标识无效');
  const scriptNonce = crypto.randomUUID().replaceAll('-', '');
  const provider = new URL('https://u.y.qq.com/cgi-bin/musicu.fcg');
  provider.search = new URLSearchParams({ format: 'jsonp', callback: 'xvyinQQCallback', data: JSON.stringify({
    req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param: { guid: String(crypto.getRandomValues(new Uint32Array(1))[0]), songmid: [songmid], songtype: [0], uin: '0', loginflag: 1, platform: '20' } },
    comm: { uin: 0, format: 'json', ct: 24, cv: 0 },
  }) }).toString();
  // All substitutions are validated identifiers or fixed origins. The provider
  // address is built here, never read from content or a query URL parameter.
  const config = JSON.stringify({ nonce, songmid, siteOrigin, provider: provider.href }).replaceAll('<', '\\u003c');
  const script = `(()=>{'use strict';const config=${config};let sent=false;
const send=(value)=>{if(sent)return;sent=true;parent.postMessage({type:'xvyin:qq-result',nonce:config.nonce,songmid:config.songmid,...value},config.siteOrigin)};
const fail=()=>send({ok:false,code:'QQ_UNAVAILABLE'});
window.xvyinQQCallback=(payload)=>{try{
if(!payload||payload.code!==0||payload.req_0?.code!==0)return fail();
const data=payload.req_0.data;if(!data||!Array.isArray(data.midurlinfo)||data.midurlinfo.length>16||!Array.isArray(data.sip)||data.sip.length>16)return fail();
const entry=data.midurlinfo.find(item=>item&&item.songmid===config.songmid&&(item.result===undefined||item.result===0)&&typeof item.purl==='string'&&item.purl.length>0&&item.purl.length<=8000);
if(!entry)return fail();
for(const base of data.sip){if(typeof base!=='string'||base.length>2000)continue;try{const url=new URL(entry.purl,base);if(url.protocol==='http:')url.protocol='https:';
if(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&(url.hostname==='qq.com'||url.hostname.endsWith('.qq.com'))&&url.href.length<=8000){send({ok:true,url:url.href});return}}catch{}}
fail();}catch{fail()}};
const script=document.createElement('script');script.src=config.provider;script.referrerPolicy='no-referrer';script.onerror=fail;document.head.append(script);setTimeout(fail,15000);
})();`;
  return new Response(request.method === 'HEAD' ? null : `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>QQ 音乐播放解析</title><script nonce="${scriptNonce}">${script}</script></html>`, { headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store',
    'content-security-policy': `sandbox allow-scripts; default-src 'none'; script-src 'nonce-${scriptNonce}' https://u.y.qq.com/cgi-bin/musicu.fcg; connect-src 'none'; img-src 'none'; style-src 'none'; font-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${siteOrigin}`,
    'cross-origin-embedder-policy': 'credentialless', 'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  } });
}
