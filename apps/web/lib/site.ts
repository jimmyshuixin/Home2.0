import data from '#site-snapshot'
import type { ProviderRef } from '@xvyin/contracts'
import type { SiteSnapshot, Variant, Creation } from './models'
import { imageSourceSet } from './image-variants'
export type * from './models'
export const site = data as SiteSnapshot
const assetsById = new Map(site.assets.map(asset => [asset.id, asset]))
export function assetPhotography(id: string) { return assetsById.get(id)?.photography }
export function assetSrcSet(id?: string | null): string | undefined { return id ? imageSourceSet(assetsById.get(id)?.variants || []) : undefined }
export function safeUrl(value?: string | null): string | undefined {
  if (!value || /[\u0000-\u0020\\]/.test(value)) return undefined
  if (value.startsWith('#')) return value
  if (value.startsWith('/') && !value.startsWith('//')) return value
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? value : undefined } catch { return undefined }
}
export function assetVariant(id?: string | null, role = 'content'): Variant | undefined {
  const asset = id ? assetsById.get(id) : undefined
  const variant = asset?.variants.find((item) => item.role === role) || (['content', 'large', 'thumb', 'poster'].includes(role) ? asset?.variants.find((item) => ['content', 'large', 'thumb'].includes(item.role)) : undefined)
  return variant && safeUrl(variant.url) ? variant : undefined
}
export function formats(entry: Creation): string[] {
  const types = entry.blocks.map((block) => block.type)
  return [types.some((type) => ['richtext', 'image', 'gallery', 'quote', 'code', 'file'].includes(type)) ? 'text' : '', types.includes('audio') ? 'audio' : '', types.includes('video') ? 'video' : ''].filter(Boolean)
}
export function formatLabel(entry: Creation): string { return formats(entry).map((type) => ({ text: '图文', audio: '音频', video: '视频' })[type]).join(' · ') }
export function ordered<T extends { sortOrder?: number; id?: string }>(items: T[]): T[] { return [...items].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.id || '').localeCompare(b.id || '')) }
export function displayDate(value?: string | null): string { return value ? value.slice(0, 10).replaceAll('-', '.') : '' }
export function displayTime(seconds: number): string { if (!Number.isFinite(seconds) || seconds < 0) return '--:--'; return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}` }
export function providerLink(ref?: ProviderRef): string | undefined {
  if (!ref) return undefined
  const id = encodeURIComponent(ref.contentId)
  return ({ bilibili: `https://www.bilibili.com/video/${id}`, youtube: `https://www.youtube.com/watch?v=${id}`, tencent: `https://y.qq.com/n/ryqq/songDetail/${id}`, netease: `https://music.163.com/#/song?id=${id}` })[ref.provider]
}
