import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { PlaylistDraftSchema } from '@xvyin/contracts';
import { createMusicHandler } from '../src/music';
import { emptySnapshot } from '../src/releases';

// Explicitly enabled, read-only verification of the actual QQ playlist. No
// fixture credentials, no writes to the site, and no media files retained.
describe.skipIf(process.env.XVYIN_LIVE_MUSIC !== '1')('actual QQ music playback', () => {
  it('resolves the original public playlist, serves cover / LRC, and decodes two seconds of anonymous audio', async () => {
    const snapshot = emptySnapshot('local_live_music_check');
    snapshot.playlists.push({ ...PlaylistDraftSchema.parse({ name: 'QQ live verification', source: 'tencent', sourceId: '9206816111', enabled: true, isDefault: true }), id: 'qq_live_check', revisionId: 'local_check', publishedAt: new Date().toISOString() });
    const handler = createMusicHandler('https://music.xvyin.com');
    const request = (path: string) => new Request(`https://test.xvyin.com/api/v1/music/${path}`);
    const playlistResponse = await handler(request('playlist/qq_live_check'), snapshot, 'local-live-check');
    const playlist = await playlistResponse.json() as { data: Array<{ id: string; coverUrl?: string }> };
    expect(playlist.data.length).toBeGreaterThan(0);
    const track = playlist.data[0]!;
    expect(track.coverUrl).toBe(`/api/v1/music/cover/qq_live_check/${track.id}`);
    const cover = await handler(request(`cover/qq_live_check/${track.id}`), snapshot, 'local-live-check');
    expect(cover.status).toBe(200); expect(cover.headers.get('content-type')).toBe('image/jpeg');
    const coverBytes = new Uint8Array(await cover.arrayBuffer()); expect(Array.from(coverBytes.slice(0, 3))).toEqual([255, 216, 255]);
    const lyrics = await handler(request(`lyrics/qq_live_check/${track.id}`), snapshot, 'local-live-check');
    const lyricBody = await lyrics.json() as { data: { lyrics: string } }; expect(lyricBody.data.lyrics).toMatch(/^\[/u);
    const stream = await handler(request(`stream/qq_live_check/${track.id}`), snapshot, 'local-live-check');
    expect(stream.status).toBe(307);
    const destination = new URL(stream.headers.get('location')!);
    expect(destination.protocol).toBe('https:'); expect(destination.hostname.endsWith('.qq.com')).toBe(true);
    const media = await fetch(destination, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    expect(media.status).toBe(200); expect(media.headers.get('content-type')).toMatch(/^audio\//u);
    // Bound the real read; never buffer a media object based on a claimed size.
    const reader = media.body!.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('Live verification audio exceeds 8 MiB'); } chunks.push(next.value); } }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const decoded = await new Promise<number | null>((resolveExit, reject) => {
      const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', '2', '-f', 'null', '-'], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'], timeout: 15000 });
      child.stderr.resume(); child.on('error', reject); child.on('close', resolveExit); child.stdin.on('error', () => {}); child.stdin.end(bytes);
    });
    expect(decoded).toBe(0);
    process.stdout.write(JSON.stringify({ scope: 'READ_ONLY_LIVE_QQ_CHECK', at: new Date().toISOString(), playlistId: '9206816111', tracks: playlist.data.length, trackId: track.id, resolverStatus: stream.status, mediaStatus: media.status, mediaHost: destination.hostname, contentType: media.headers.get('content-type'), audioBytes: size, decodedSeconds: 2, ffmpegExit: decoded, coverBytes: coverBytes.length, lyricsCharacters: lyricBody.data.lyrics.length, filesRetained: 0 }) + '\n');
  }, 60000);
});
