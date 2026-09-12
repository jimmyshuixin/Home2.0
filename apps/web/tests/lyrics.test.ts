import { describe, expect, it } from 'vitest'
import { parseLyrics } from '../lib/lyrics'
describe('LRC synchronization', () => {
  it('handles repeated timestamps, metadata and offset without rendering raw timing tags', () => {
    expect(parseLyrics('[ti:测试曲目]\n[offset:500]\n[00:01.25][01:02.500]一句歌词\n[00:03.00]第二句')).toEqual([{ time: 1.75, text: '一句歌词' }, { time: 3.5, text: '第二句' }, { time: 63, text: '一句歌词' }])
  })
  it('preserves unsynchronized plain text and discards empty timed lines', () => { expect(parseLyrics('普通歌词\n[00:01.00]\n')).toEqual([{ time: -1, text: '普通歌词' }]) })
})
