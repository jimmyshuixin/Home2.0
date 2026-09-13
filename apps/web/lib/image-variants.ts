import type { PublicMediaVariant } from '@xvyin/contracts'

/** Choose already-produced widths; never request originals or an image service. */
export function imageSourceSet(variants: readonly PublicMediaVariant[]): string | undefined {
  const widths = new Map<number, PublicMediaVariant>()
  for (const variant of variants) {
    if (!['thumb', 'content', 'large'].includes(variant.role) || !variant.mime.startsWith('image/')
      || !variant.width || !Number.isSafeInteger(variant.width) || variant.width < 1
      || !variant.url.startsWith('/api/v1/media/') || /[\s,\\]/u.test(variant.url)) continue
    const current = widths.get(variant.width)
    if (!current || variant.bytes < current.bytes) widths.set(variant.width, variant)
  }
  return widths.size > 1 ? [...widths].sort(([a], [b]) => a - b).map(([width, variant]) => `${variant.url} ${width}w`).join(', ') : undefined
}
