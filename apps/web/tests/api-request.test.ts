import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../lib/api-request'

const result = { data: [{ id: 'comment-1' }], meta: { requestId: 'read-1', schemaVersion: 1 } }
const response = () => Response.json(result)
const mockFetch = () => vi.fn<typeof fetch>()

describe('public API request recovery', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('returns a successful response without extra attempts or retained timers', async () => {
    vi.useFakeTimers()
    const fetcher = mockFetch().mockResolvedValue(response())
    expect(await createApiClient('/api/v1', fetcher)('/comments')).toEqual(result)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('recovers a transient connection failure once, using the same GET URL', async () => {
    vi.useFakeTimers()
    const fetcher = mockFetch().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(response())
    const pending = createApiClient('/api/v1', fetcher)('/comments?cursor=next')
    await vi.advanceTimersByTimeAsync(299)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual(result)
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/v1/comments?cursor=next', '/api/v1/comments?cursor=next'])
  })

  it('stops after two failed GET attempts', async () => {
    vi.useFakeTimers()
    const fetcher = mockFetch().mockRejectedValue(new TypeError('offline'))
    const checked = expect(createApiClient('/api/v1', fetcher)('/comments')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await vi.runAllTimersAsync()
    await checked
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('includes a stalled response body in the deadline and recovers on the next attempt', async () => {
    vi.useFakeTimers()
    let firstSignal: AbortSignal | undefined
    const fetcher = mockFetch().mockImplementationOnce(async (_, options) => {
      firstSignal = options?.signal as AbortSignal
      return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{"data":')) } }))
    }).mockResolvedValueOnce(response())
    const pending = createApiClient('/api/v1', fetcher)('/comments')
    await vi.advanceTimersByTimeAsync(15000)
    expect(firstSignal?.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300)
    expect(await pending).toEqual(result)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds both hung attempts even when the transport does not honor abort', async () => {
    vi.useFakeTimers()
    const fetcher = mockFetch().mockImplementation(() => new Promise(() => {}))
    const checked = expect(createApiClient('/api/v1', fetcher)('/comments')).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(30300)
    await checked
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never sends a request when the caller already cancelled', async () => {
    const controller = new AbortController(); controller.abort()
    const fetcher = mockFetch()
    await expect(createApiClient('/api/v1', fetcher)('/comments', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['headers', 'body', 'backoff'])('does not retry or report timeout when cancelled during %s', async phase => {
    vi.useFakeTimers()
    const controller = new AbortController(), fetcher = mockFetch()
    if (phase === 'headers') fetcher.mockImplementation(() => new Promise(() => {}))
    if (phase === 'body') fetcher.mockResolvedValue(new Response(new ReadableStream()))
    if (phase === 'backoff') fetcher.mockRejectedValue(new TypeError('connection reset'))
    const pending = createApiClient('/api/v1', fetcher)('/comments', { signal: controller.signal })
    const checked = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await checked
    await vi.runAllTimersAsync()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([408, 502, 503, 504])('recovers transient HTTP %i once, including a non-JSON gateway response', async status => {
    vi.useFakeTimers()
    const fetcher = mockFetch().mockResolvedValueOnce(new Response('temporary upstream error', { status })).mockResolvedValueOnce(response())
    const pending = createApiClient('/api/v1', fetcher)('/comments')
    await vi.runAllTimersAsync()
    expect(await pending).toEqual(result)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([400, 401, 403, 404, 409, 429, 500])('does not replay HTTP %i and preserves the error request ID', async status => {
    const fetcher = mockFetch().mockResolvedValue(Response.json({ error: { code: 'REJECTED', message: '请稍后再试' }, meta: { requestId: 'rejected-1' } }, { status }))
    await expect(createApiClient('/api/v1', fetcher)('/comments')).rejects.toMatchObject({ status, code: 'REJECTED', requestId: 'rejected-1' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 409, 429, 500])('does not turn HTTP %i into a retryable error when its body stalls', async status => {
    vi.useFakeTimers()
    const fetcher = mockFetch().mockResolvedValue(new Response(new ReadableStream(), { status }))
    const checked = expect(createApiClient('/api/v1', fetcher)('/comments')).rejects.toMatchObject({ status, code: 'REQUEST_TIMEOUT', retryable: false })
    await vi.runAllTimersAsync()
    await checked
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 409, 429, 500])('does not replay HTTP %i when reading its body fails', async status => {
    const fetcher = mockFetch().mockResolvedValue(new Response(new ReadableStream({ start(stream) { stream.error(new TypeError('body connection closed')) } }), { status }))
    await expect(createApiClient('/api/v1', fetcher)('/comments')).rejects.toMatchObject({ status, retryable: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('never automatically replays a %s write or changes its idempotency key', async method => {
    const fetcher = mockFetch().mockRejectedValue(new TypeError('connection closed after write'))
    await expect(createApiClient('/api/v1', fetcher)('/comments', { method, body: { body: 'draft' }, idempotencyKey: 'same-user-action' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method, body: '{"body":"draft"}', headers: { 'Idempotency-Key': 'same-user-action' } })
  })

  it.each(['null', 'false', '[]', 'invalid json'])('rejects malformed successful response %s without automatic replay', async body => {
    const fetcher = mockFetch().mockResolvedValue(new Response(body))
    await expect(createApiClient('/api/v1', fetcher)('/comments')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
