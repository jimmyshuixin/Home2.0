import { api, type MediaItem } from './api';
import { MediaFocusManager } from '../../web/lib/media-focus';

export const adminMediaFocus = new MediaFocusManager();
const pending = new Map<string, Promise<MediaItem>>();
const waiting: Array<() => void> = [];
let reading = 0;
async function limitRead<T>(read: () => Promise<T>): Promise<T> {
  if (reading >= 4) await new Promise<void>(resolve => waiting.push(resolve));
  else reading++;
  try { return await read(); } finally { const next = waiting.shift(); if (next) next(); else reading--; }
}

// Coalesce simultaneous references to the same asset. Do not retain private
// metadata across sessions or cache processing/error states indefinitely.
export function readMedia(id: string): Promise<MediaItem> {
  const existing = pending.get(id);
  if (existing) return existing;
  const request = limitRead(() => api.request<MediaItem>(`/admin/media/${encodeURIComponent(id)}`).then(result => result.data));
  pending.set(id, request);
  void request.finally(() => pending.delete(id)).catch(() => {});
  return request;
}

export function privateMediaUrl(item: MediaItem, roles: string[]): string | undefined {
  if ((item.processingStatus ?? item.status) !== 'ready') return;
  const role = roles.find(role => item.variants.some(variant => variant.role === role));
  return role ? `/api/v1/admin/media/${encodeURIComponent(item.id)}/${encodeURIComponent(role)}` : undefined;
}

export function previewSource(item: MediaItem, compact = false): string | undefined {
  return privateMediaUrl(item, item.kind === 'image'
    ? compact ? ['thumb', 'content', 'poster'] : ['content', 'poster', 'thumb']
    : item.kind === 'file' ? ['download', 'captions'] : ['playback']);
}

export function externalMediaLink(ref?: { provider: string; contentId: string }): string | undefined {
  if (!ref?.contentId.trim()) return;
  const id = encodeURIComponent(ref.contentId.trim());
  return ({ bilibili: `https://www.bilibili.com/video/${id}`, youtube: `https://www.youtube.com/watch?v=${id}`, douyin: `https://www.douyin.com/video/${id}`, tencent: `https://y.qq.com/n/ryqq/songDetail/${id}`, netease: `https://music.163.com/#/song?id=${id}` } as Record<string, string>)[ref.provider];
}

export function safePreviewLink(value?: string): string | undefined {
  if (!value) return;
  try { const url = new URL(value, 'https://xvyin.com'); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return; }
}
