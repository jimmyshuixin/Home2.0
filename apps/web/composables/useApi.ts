export type ApiResult<T> = { data: T; meta: { requestId: string; schemaVersion: number; nextCursor?: string | null } }
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) { super(message) }
}
export function useApi() {
  const config = useRuntimeConfig()
  return async function api<T>(path: string, options: { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<ApiResult<T>> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const cancel = () => controller.abort()
    options.signal?.addEventListener('abort', cancel, { once: true })
    let response: Response
    try {
    response = await fetch(`${config.public.apiBase}${path}`, {
      method: options.method || 'GET', credentials: 'same-origin', signal: controller.signal,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined
    })
    } catch { throw new ApiError(503, 'SERVICE_UNAVAILABLE', controller.signal.aborted ? '连接超时，内容已保留，请重试。' : '暂时无法连接，请稍后重试。') }
    finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', cancel) }
    const body = await response.json().catch(() => null)
    if (!response.ok || !body || !('data' in body)) throw new ApiError(response.status, body?.error?.code || 'SERVICE_UNAVAILABLE', body?.error?.message || '暂时无法连接，请稍后重试。', body?.meta?.requestId)
    return body
  }
}
