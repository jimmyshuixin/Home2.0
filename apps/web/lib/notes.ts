import type { Creation, SiteSnapshot } from './models';

export function publishedNotes(creations: readonly Creation[]): Creation[] {
  return creations.filter(entry => entry.kind === 'note').sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
}

export function noteDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

export function visibleNow(settings: Pick<SiteSnapshot['settings'], 'now'>) {
  const now = settings.now;
  return now?.enabled && now.text.trim() && now.updatedAt ? now : null;
}
