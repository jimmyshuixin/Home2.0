import { describe, it, expect } from 'vitest'
import { imageSourceSet } from '../lib/image-variants'
import type { PublicMediaVariant } from '@xvyin/contracts'
const variant = (role: PublicMediaVariant['role'], width: number, bytes = width): PublicMediaVariant => ({ role, width, height: width, mime: 'image/webp', bytes, url: `/api/v1/media/image/${role}` })
describe('responsive image variants', () => {
  it('orders real widths and avoids duplicate original-size candidates', () => {
    expect(imageSourceSet([variant('large', 720, 900), variant('thumb', 384), variant('content', 720, 700)]))
      .toBe('/api/v1/media/image/thumb 384w, /api/v1/media/image/content 720w')
  })
  it('does not expose originals, unsafe srcsets or non-image variants', () => {
    expect(imageSourceSet([variant('download', 1600), { ...variant('content', 960), url: '/api/v1/media/a/content, /private/a' }, { ...variant('large', 1600), mime: 'video/mp4' }])).toBeUndefined()
    expect(imageSourceSet([variant('thumb', 300), variant('content', 300)])).toBeUndefined()
  })
})
