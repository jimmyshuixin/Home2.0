export type ApiResult<T> = { data: T; meta: { requestId: string; schemaVersion: number; nextCursor?: string | null; catalogReady?: boolean } }
export type ApiOptions = { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string, public retryable = false) { super(message) }
}

const timeoutMs = 15000
const retryDelayMs = 300
const transientStatus = new Set([408, 502, 503, 504])
const cancelled = () => new DOMException('Request cancelled', 'AbortError')

function delay(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return }
    const abort = () => { clearTimeout(timer); reject(cancelled()) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, retryDelayMs)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function attempt<T>(url: string, options: ApiOptions, fetcher: typeof fetch): Promise<ApiResult<T>> {
  if (options.signal?.aborted) throw cancelled()
  const controller = new AbortController()
  let receivedStatus: number | undefined
  const retryableTransport = () => receivedStatus === undefined || receivedStatus >= 200 && receivedStatus < 300 || transientStatus.has(receivedStatus)
  const transportStatus = () => retryableTransport() ? 503 : receivedStatus!
  let interrupt!: (error: Error) => void
  const interrupted = new Promise<never>((_, reject) => { interrupt = reject })
  const cancel = () => { interrupt(cancelled()); controller.abort() }
  const timeout = setTimeout(() => {
    interrupt(new ApiError(transportStatus(), 'REQUEST_TIMEOUT', '连接超时，请重试。', undefined, retryableTransport()))
    controller.abort()
  }, timeoutMs)
  options.signal?.addEventListener('abort', cancel, { once: true })
  try {
    // The deadline includes the response body: receiving headers is not completion.
    return await Promise.race([interrupted, (async () => {
      const response = await fetcher(url, {
        method: options.method || 'GET', credentials: 'same-origin', signal: controller.signal,
        headers: { Accept: 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}) },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      })
      receivedStatus = response.status
      let body: unknown
      try { body = await response.json() }
      catch (error) {
        if (controller.signal.aborted || !(error instanceof SyntaxError)) throw error
      }
      const envelope = body && typeof body === 'object' ? body as Record<string, any> : null
      if (!response.ok || !envelope || !('data' in envelope)) {
        throw new ApiError(response.status, envelope?.error?.code || 'SERVICE_UNAVAILABLE', envelope?.error?.message || '暂时无法连接，请稍后重试。', envelope?.meta?.requestId, transientStatus.has(response.status))
      }
      return envelope as ApiResult<T>
    })()])
  } catch (error) {
    if (options.signal?.aborted) throw cancelled()
    if (error instanceof ApiError) throw error
    throw new ApiError(transportStatus(), 'SERVICE_UNAVAILABLE', '暂时无法连接，请稍后重试。', undefined, retryableTransport())
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', cancel)
  }
}

export function createApiClient(base: string, fetcher: typeof fetch = fetch) {
  return async function api<T>(path: string, options: ApiOptions = {}): Promise<ApiResult<T>> {
    const method = (options.method || 'GET').toUpperCase()
    for (let index = 0; ; index++) {
      try { return await attempt<T>(`${base}${path}`, { ...options, method }, fetcher) }
      catch (error) {
        // A single short retry is only safe for reads. Writes retain their original
        // idempotency key and are retried only by an explicit user action.
        if (method !== 'GET' || index > 0 || !(error instanceof ApiError) || !error.retryable || options.signal?.aborted) throw error
        await delay(options.signal)
      }
    }
  }
}
