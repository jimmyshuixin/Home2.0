/** Pages advanced-mode gateway. Business logic lives in the separately deployed API Worker. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'test.xvyin.com') {
      url.hostname = 'xvyin.com';
      return Response.redirect(url.toString(), 308);
    }
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      const isStaticAsset = url.pathname.startsWith('/admin/assets/') || url.pathname.startsWith('/admin/fonts/');
      const path = isStaticAsset ? url.pathname : '/admin/';
      const target = new URL(path, url.origin);
      const response = await env.ASSETS.fetch(new Request(target, request));
      const headers = new Headers(response.headers);
      headers.set('cache-control', isStaticAsset ? 'public, max-age=31536000, immutable' : 'private, no-store');
      headers.set('x-robots-tag', 'noindex, nofollow'); headers.set('x-content-type-options', 'nosniff');
      headers.set('referrer-policy', 'no-referrer'); headers.set('x-frame-options', 'DENY');
      headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
      return new Response(response.body, { status: response.status, headers });
    }
    return env.API.fetch(request);
  },
};
