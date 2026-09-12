export interface Envelope<T> { data: T; meta: { requestId: string; schemaVersion: number; nextCursor?: string; releaseId?: string | null; activeReleaseId?: string | null; previewReleaseId?: string | null; quota?: { limitBytes: number; usedBytes: number; reservedBytes: number } } }
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string, readonly fields?: Record<string, string[]>) { super(message); this.name = 'ApiError'; }
}

export class AdminApi {
  csrfToken = '';
  onExpired?: () => void;
  constructor(private readonly transport: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async request<T>(path: string, options: { method?: string; body?: unknown; rawBody?: Blob; signal?: AbortSignal; idempotencyKey?: string } = {}): Promise<Envelope<T>> {
    const method = options.method ?? 'GET';
    let response: Response;
    try {
      response = await this.transport(`/api/v1${path}`, {
        method, credentials: 'include', cache: 'no-store', signal: options.signal,
        headers: { Accept: 'application/json', ...(options.rawBody ? { 'Content-Type': 'application/octet-stream' } : options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && this.csrfToken ? { 'X-CSRF-Token': this.csrfToken } : {}), ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}) },
        ...(options.rawBody ? { body: options.rawBody } : options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(0, 'NETWORK_ERROR', '无法连接内容服务，请检查网络后重试。');
    }
    let result: { data?: T; error?: { code?: string; message?: string; fields?: Record<string, string[]> }; meta?: Envelope<T>['meta'] };
    try { result = await response.json(); } catch { throw new ApiError(response.status, 'INVALID_RESPONSE', '内容服务返回了无法识别的响应。'); }
    if (!response.ok || result.error) {
      if (response.status === 401 && path !== '/auth/login' && path !== '/auth/session') this.onExpired?.();
      throw new ApiError(response.status, result.error?.code ?? 'REQUEST_FAILED', result.error?.message ?? '操作未完成，请重试。', result.meta?.requestId, result.error?.fields);
    }
    if (!('data' in result) || !result.meta) throw new ApiError(response.status, 'INVALID_RESPONSE', '内容服务响应缺少必要信息。');
    return result as Envelope<T>;
  }
}
export const api = new AdminApi();
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.fields) return `${error.message} ${Object.entries(error.fields).map(([field, messages]) => `${field}：${messages.join('；')}`).join(' / ')}`;
  return error instanceof Error ? error.message : '操作未完成，请稍后重试。';
}
export interface DraftRecord<T = Record<string, unknown>> {
  id: string; version: number; draft: T; visibility: 'draft' | 'published' | 'hidden';
  draftRevisionId: string; lastPublishedRevisionId: string | null; createdAt: string; updatedAt: string;
}
export type Collection = 'creations' | 'albums' | 'fitness' | 'playlists';
export interface MediaItem { id: string; kind: 'image' | 'audio' | 'video' | 'file'; originalName?: string; originalBytes: number; processingStatus?: string; status?: string; previewUrl?: string; metadata?: { width?: number; height?: number }; variants: { role: string; url?: string }[]; error?: { code: string; message: string } }
export function mediaPreview(item: MediaItem): string | undefined {
  if ((item.processingStatus ?? item.status) !== 'ready') return;
  const variant = item.variants.find(value => ['thumb', 'content'].includes(value.role)) ?? item.variants[0];
  return variant ? `/api/v1/admin/media/${encodeURIComponent(item.id)}/${encodeURIComponent(variant.role)}` : undefined;
}
export interface ReleaseJob { id: string; status: string; previewUrl?: string; error?: { code?: string; message?: string }; errorCode?: string; createdAt?: string; releaseId?: string; previousReleaseId?: string | null; changes?: { collection: string; id: string; version: number; action: string }[] }
export function formatBytes(bytes: number): string { if (!Number.isFinite(bytes)) return '—'; return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(bytes / 1e3)} KB`; }
export function dateTime(value?: string): string { if (!value) return '尚未记录'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '日期无效' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(date); }
export function visibilityLabel(value: string): string { return ({ draft: '草稿', published: '已发布', hidden: '已隐藏', pending: '待审核', approved: '已通过', rejected: '已拒绝' } as Record<string, string>)[value] ?? value; }
