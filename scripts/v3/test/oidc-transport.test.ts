import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunnerTransport } from '../publish';

const environment = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/oidc?private-query=do-not-display',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private-signing-credential',
};
const path = '/api/v1/internal/releases/11111111-1111-4111-8111-111111111111';
const identity = (value = 'header.valid.signature') => Response.json({ value });
const issuer = (url: URL) => url.hostname.endsWith('.actions.githubusercontent.com');
const create = (fetcher: typeof fetch, extra: Partial<Parameters<typeof createRunnerTransport>[0]> = {}) => createRunnerTransport({
  origin: 'https://xvyin.com', mode: 'github', localRunId: '22222222-2222-4222-8222-222222222222', fetch: fetcher, environment, ...extra,
});
const networkFailure = () => new TypeError('PRIVATE URL https://issuer.invalid/?token=secret', { cause: Object.assign(new Error('private issuer detail'), { code: 'ECONNRESET' }) });

describe('bounded OIDC issuer recovery', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('recovers a transport failure after the 180-second cache expires without replaying the upload or reusing the old token', async () => {
    vi.useFakeTimers(); let now = 1000, issued = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
      if (!issuer(input as URL)) return Response.json({ data: { accepted: true } });
      issued++;
      if (issued === 2) throw networkFailure();
      return identity(issued === 1 ? 'header.first.signature' : 'header.refreshed.signature');
    });
    const client = create(fetcher, { now: () => now });
    await client.request(path);
    now += 179999; await client.request(path);
    expect(issued).toBe(1);
    now += 2;
    const pending = client.request(path + '/file?path=%2Findex.html', { method: 'PUT', body: new Uint8Array([1, 2, 3]) });
    await vi.advanceTimersByTimeAsync(300); await pending;
    expect(issued).toBe(3);
    const apiCalls = fetcher.mock.calls.filter(([input]) => !issuer(input as URL));
    expect(apiCalls).toHaveLength(3);
    expect((apiCalls[2]![1]!.headers as Headers).get('Authorization')).toBe('Bearer header.refreshed.signature');
    expect(apiCalls[2]![1]).toMatchObject({ method: 'PUT', body: new Uint8Array([1, 2, 3]) });
    for (const [url, options] of fetcher.mock.calls.filter(([input]) => issuer(input as URL))) {
      expect((url as URL).origin).toBe('https://pipelines.actions.githubusercontent.com');
      expect((url as URL).searchParams.get('audience')).toBe('https://xvyin.com/v3-runner');
      expect(options).toMatchObject({ method: 'GET', redirect: 'error' });
    }
  });

  it('stops after two issuer transport failures and exposes neither secrets nor the underlying exception', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>().mockRejectedValue(networkFailure());
    const pending = create(fetcher).request(path).catch(error => error);
    await vi.runAllTimersAsync(); const error = await pending;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ code: 'OIDC_UNAVAILABLE' });
    expect(error.cause).toBeUndefined();
    expect(String(error) + JSON.stringify(error) + error.stack).not.toMatch(/PRIVATE|https:|token=|private-query|private-signing|ECONNRESET/);
  });

  it('never falls back to an expired cached token when refresh fails', async () => {
    vi.useFakeTimers(); let now = 1, issued = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
      if (!issuer(input as URL)) return Response.json({ data: {} });
      if (++issued === 1) return identity('header.expired.signature');
      throw networkFailure();
    });
    const client = create(fetcher, { now: () => now }); await client.request(path); now += 180001;
    const pending = client.request(path + '/file', { method: 'PUT', body: 'immutable bytes' }).catch(error => error);
    await vi.runAllTimersAsync(); expect(await pending).toMatchObject({ code: 'OIDC_UNAVAILABLE' });
    expect(issued).toBe(3);
    expect(fetcher.mock.calls.filter(([input]) => !issuer(input as URL))).toHaveLength(1);
  });

  it.each([502, 503, 504])('retries issuer HTTP %i once without waiting for its error body cancellation', async status => {
    vi.useFakeTimers(); const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status })).mockResolvedValueOnce(identity()).mockResolvedValueOnce(Response.json({ data: {} }));
    const pending = create(fetcher).request(path); await vi.advanceTimersByTimeAsync(300); await pending;
    expect(fetcher).toHaveBeenCalledTimes(3); expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 400, 401, 403, 404, 408, 429, 500])('does not retry issuer HTTP %i even with a never-ending error body', async status => {
    vi.useFakeTimers(); const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status }));
    const checked = expect(create(fetcher).request(path)).rejects.toMatchObject({ code: 'OIDC_UNAVAILABLE' });
    await vi.runAllTimersAsync(); await checked;
    expect(fetcher).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps the 15-second deadline active after headers and recovers a stalled successful body', async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{"value":"')); }, cancel }))).mockResolvedValueOnce(identity()).mockResolvedValueOnce(Response.json({ data: {} }));
    const pending = create(fetcher).request(path);
    await vi.advanceTimersByTimeAsync(15000);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300); await pending;
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('still exits on time when a stalled successful body never settles its cancel operation', async () => {
    vi.useFakeTimers(); const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream({ cancel })));
    const checked = expect(create(fetcher).request(path)).rejects.toMatchObject({ code: 'OIDC_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(30300); await checked;
    expect(fetcher).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(2);
  });

  it.each([
    [200, { 'content-type': 'text/html' }],
    [200, { 'cf-mitigated': 'challenge' }],
    [502, { 'cf-mitigated': 'challenge' }],
    [503, { 'cf-mitigated': 'challenge' }],
  ] as const)('hard-rejects an HTML/challenge issuer response with HTTP %i before token parsing or retry', async (status, headers) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ value: 'header.valid.signature' }), { status, headers }));
    await expect(create(fetcher).request(path)).rejects.toMatchObject({ code: 'OIDC_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds a transport that ignores abort at two attempts and 30.3 seconds', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const checked = expect(create(fetcher).request(path)).rejects.toMatchObject({ code: 'OIDC_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(30300); await checked;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can recover a successful response body connection reset once', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({ start(stream) { stream.error(networkFailure()); } }))).mockResolvedValueOnce(identity()).mockResolvedValueOnce(Response.json({ data: {} }));
    const pending = create(fetcher).request(path); await vi.advanceTimersByTimeAsync(300); await pending;
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(['not-json PRIVATE', '{"value":"not.a.valid.token"}', 'null', '{"value":42}'])('does not retry invalid issuer payload %s', async body => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const error = await create(fetcher).request(path).catch(error => error);
    expect(error).toMatchObject({ code: 'OIDC_UNAVAILABLE' }); expect(String(error)).not.toContain(body);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds successful issuer bodies to 20 KB without retrying or revealing contents', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('private-signing-credential'.repeat(1000))); }, cancel })));
    const error = await create(fetcher).request(path).catch(error => error);
    expect(error).toMatchObject({ code: 'OIDC_UNAVAILABLE' }); expect(String(error)).not.toContain('private-signing');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(['headers', 'body', 'backoff'])('honors caller cancellation during issuer %s without retrying or sending the API request', async phase => {
    vi.useFakeTimers(); const controller = new AbortController(), fetcher = vi.fn<typeof fetch>();
    if (phase === 'headers') fetcher.mockImplementation(() => new Promise(() => {}));
    if (phase === 'body') fetcher.mockResolvedValue(new Response(new ReadableStream()));
    if (phase === 'backoff') fetcher.mockRejectedValue(networkFailure());
    const pending = create(fetcher).request(path, { signal: controller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0); controller.abort(new Error('private cancel reason'));
    expect(await pending).toMatchObject({ code: 'REQUEST_ABORTED' }); await vi.runAllTimersAsync();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects an already-cancelled request even when its OIDC cache is valid', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(identity()).mockResolvedValueOnce(Response.json({ data: {} }));
    const client = create(fetcher); await client.request(path);
    const controller = new AbortController(); controller.abort();
    await expect(client.request(path, { signal: controller.signal })).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('includes credential acquisition in the caller request timeout budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const start = performance.now();
    await expect(create(fetcher, { requestTimeoutMs: 1000 }).request(path)).rejects.toMatchObject({ code: 'OIDC_UNAVAILABLE' });
    expect(performance.now() - start).toBeLessThan(3000); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['https://evil.invalid/oidc', 'http://pipelines.actions.githubusercontent.com/oidc', 'https://user:pass@pipelines.actions.githubusercontent.com/oidc', 'not a URL'])('rejects invalid signing address without making a request', async url => {
    const fetcher = vi.fn<typeof fetch>();
    const error = await create(fetcher, { environment: { ...environment, ACTIONS_ID_TOKEN_REQUEST_URL: url } }).request(path).catch(error => error);
    expect(error).toMatchObject({ code: 'OIDC_UNAVAILABLE' }); expect(String(error)).not.toContain(url); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
    new TypeError('fetch failed', { cause: Object.assign(new Error('private certificate detail'), { code: 'CERT_HAS_EXPIRED' }) }),
    Object.assign(new TypeError('invalid private configuration'), { code: 'ERR_INVALID_ARG_TYPE' }),
  ])('does not retry redirect, certificate or configuration failures', async error => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(create(fetcher).request(path)).rejects.toMatchObject({ code: 'OIDC_UNAVAILABLE' }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
