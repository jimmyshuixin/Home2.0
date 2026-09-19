import { describe, expect, it } from 'vitest'
import { photographyRows } from '../lib/photography'
describe('photo metadata display', () => {
  it('formats camera exposure without duplicating make or inventing a timezone', () => {
    expect(photographyRows({cameraMake:'Canon',cameraModel:'Canon EOS R5',exposureSeconds:1/250,aperture:2.8,iso:400,takenAt:'2026-09-18T19:20:30'})).toEqual([
      {label:'相机',value:'Canon EOS R5'},{label:'光圈',value:'f/2.8'},{label:'快门',value:'1/250 s'},{label:'感光度',value:'ISO 400'},{label:'拍摄时间',value:'2026-09-18 19:20:30'}
    ])
  })
  it('preserves long exposures, honors manual dates, and omits absent metadata', () => {
    expect(photographyRows()).toEqual([])
    expect(photographyRows({exposureSeconds:30,takenDate:'2026-09-18',iso:NaN},true)).toEqual([{label:'快门',value:'30 s'}])
  })
})
