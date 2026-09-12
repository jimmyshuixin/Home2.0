export interface LyricLine { time: number; text: string }
/** LRC can assign the same lyric to several timestamps. Metadata is not a line. */
export function parseLyrics(source: string): LyricLine[] {
  const offset = Number(source.match(/^\[offset:([+-]?\d+)\]$/im)?.[1] || 0) / 1000;
  const lines: LyricLine[] = [];
  for (const raw of source.slice(0, 200000).split(/\r?\n/)) {
    if (/^\[(?:ar|al|ti|au|by|offset|re|ve|length):/i.test(raw)) continue;
    const timestamps = [...raw.matchAll(/\[(\d{1,3}):([0-5]\d(?:\.\d{1,3})?)\]/g)];
    const text = raw.replace(/\[(\d{1,3}):([0-5]\d(?:\.\d{1,3})?)\]/g, '').trim();
    if (!text) continue;
    if (!timestamps.length) lines.push({ time: -1, text });
    else for (const match of timestamps) lines.push({ time: Math.max(0, Number(match[1]) * 60 + Number(match[2]) + offset), text });
  }
  return lines.sort((a, b) => a.time - b.time);
}
