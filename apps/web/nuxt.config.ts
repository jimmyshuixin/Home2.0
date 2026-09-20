import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publicSnapshot } from './lib/build-snapshot'

const root = dirname(fileURLToPath(import.meta.url))
const source = process.env.XVYIN_SNAPSHOT_PATH
const snapshot = publicSnapshot(source ? JSON.parse(readFileSync(resolve(source), 'utf8')) : undefined)
const publicOrigin = new URL(process.env.XVYIN_PUBLIC_ORIGIN || 'https://test.xvyin.com').origin
const indexable = process.env.XVYIN_INDEXABLE === 'true' && publicOrigin === 'https://xvyin.com'
const generated = resolve(root, '.data/site.json')
mkdirSync(dirname(generated), { recursive: true })
writeFileSync(generated, JSON.stringify(snapshot))
const routes = ['/', '/about', '/creations', '/photography', '/fitness', '/guestbook', '/contact',
  ...snapshot.creations.map((entry) => `/creations/${entry.slug}`),
  ...snapshot.albums.map((album) => `/photography/${album.slug}`)]
const generatedPublic = resolve(root, '.data/public')
mkdirSync(generatedPublic, { recursive: true })
writeFileSync(resolve(generatedPublic, 'robots.txt'), indexable ? `User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: ${publicOrigin}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n')
writeFileSync(resolve(generatedPublic, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${indexable ? routes.map((route) => `<url><loc>${publicOrigin}${route}</loc></url>`).join('') : ''}</urlset>`)

export default defineNuxtConfig({
  compatibilityDate: '2026-09-12',
  srcDir: './',
  ssr: true,
  devtools: { enabled: false },
  telemetry: false,
  alias: { '#site-snapshot': generated },
  css: ['~/assets/site.css', '~/assets/reading.css', '~/assets/editorial.css', '~/assets/ink.css', '~/assets/ink-interior.css'],
  runtimeConfig: { public: { apiBase: '/api/v1', publicOrigin, indexable } },
  app: { head: { htmlAttrs: { lang: 'zh-CN' }, title: '虚宁 · xvyin.com',
    meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#F7F3E9' }, { name: 'xvyin-release', content: snapshot.releaseId }, { name: 'robots', content: indexable ? 'index,follow' : 'noindex,nofollow' }, { name: 'description', content: '虚宁的个人网站。创作、摄影与日常记录。' }],
    link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }, { rel: 'stylesheet', href: '/fonts/xvyin-serif-critical.css' }, { rel: 'preload', href: '/fonts/xvyin-serif-critical.woff2', as: 'font', type: 'font/woff2', crossorigin: 'anonymous' }] } },
  nitro: { publicAssets: [{ dir: generatedPublic }], prerender: { crawlLinks: false, routes, failOnError: true }, devProxy: { '/api': { target: `${process.env.XVYIN_DEV_API_ORIGIN || 'http://127.0.0.1:8787'}/api`, changeOrigin: false } } },
  experimental: { payloadExtraction: true, defaults: { nuxtLink: { prefetchOn: { visibility: false, interaction: true } } } },
  typescript: { strict: true }
})
