import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRunnerTransport, deterministicFailure, internalRunnerUrl, PublishError, RunnerClient } from '../publish';

const run = randomUUID();
const credentials = { cookie: '__Host-xvyin_session=' + 'a'.repeat(43), csrfToken: 'b'.repeat(43) };
const environment = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/oidc',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private-issuer-request-token',
};
const internalPath = '/api/v1/internal/releases/' + randomUUID();
const approvedOrigins = ['https://test.xvyin.com', 'https://xvyin.com'] as const;

describe('fixed GitHub V3-project transport', () => {
  it.each([
    ['github', 'https://test.xvyin.com', 'https://xvyin-v3-test.pages.dev'],
    ['local', 'https://test.xvyin.com', 'https://test.xvyin.com'],
    ['github', 'https://xvyin.com', 'https://xvyin-v3-test.pages.dev'],
    ['local', 'https://xvyin.com', 'https://xvyin.com'],
  ] as const)('maps only %s internal traffic for %s to %s', (mode, origin, transport) => {
    expect(internalRunnerUrl(origin, mode, internalPath).href).toBe(transport + internalPath);
  });

  it.each(approvedOrigins)('preserves the %s upload query while keeping its values out of the transport host', origin => {
    const path = internalPath + '/file?path=%2F_nuxt%2Fcontent-123.js&origin=https%3A%2F%2Fevil.invalid';
    expect(internalRunnerUrl(origin, 'github', path).href).toBe('https://xvyin-v3-test.pages.dev' + path);
  });

  it.each(approvedOrigins)('rejects host injection, public paths and encoded traversal for %s before OIDC', async origin => {
    const fetcher = vi.fn();
    const client = createRunnerTransport({ origin, mode: 'github', localRunId: run, environment, fetch: fetcher });
    for (const path of [
      'https://evil.invalid/api/v1/internal/releases/id', '//xvyin-v3-test.pages.dev/api/v1/internal/releases/id',
      '/api/v1/admin/releases', '/api/v1/internal', '/api/v1/internal//releases/id', '/api/v1/internal/../admin',
      '/api/v1/internal/%2e%2e/admin', '/api/v1/internal/%252e%252e/admin', '/api/v1/internal/releases%2f..%2fadmin',
      '/api/v1/internal/releases\\id', '/api/v1/internal/releases/id#fragment', '/api/v1/internal/releases/id\n',
    ]) await expect(client.request(path)).rejects.toMatchObject({ code: 'INVALID_REQUEST_PATH' });
    for (const untrusted of ['https://other.pages.dev', 'https://xvyin-v3-test.pages.dev', 'https://test.xvyin.com.evil.invalid', 'https://xvyin.com.evil.invalid']) {
      expect(() => new RunnerClient(untrusted, { mode: 'github', localRunId: run }, undefined, fetcher)).toThrowError(PublishError);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(approvedOrigins)('retains the %s audience and Origin, replaces supplied identity/host headers, and forbids redirects', async origin => {
    const fetcher = vi.fn().mockImplementation(async (input: URL) => input.hostname.endsWith('.actions.githubusercontent.com')
      ? Response.json({ value: 'header.payload.signature' }) : Response.json({ data: { accepted: true } }));
    const client = createRunnerTransport({ origin, mode: 'github', localRunId: run, environment: {
      ...environment, XVYIN_RUNNER_ORIGIN: 'https://evil.invalid', XVYIN_TRANSPORT_ORIGIN: 'https://evil.invalid',
    }, fetch: fetcher });
    await client.request(internalPath + '/claim', { method: 'POST', body: '{}', redirect: 'follow', headers: {
      Origin: 'https://evil.invalid', Authorization: 'Bearer user-supplied', Cookie: credentials.cookie,
      'X-CSRF-Token': credentials.csrfToken, 'X-Xvyin-Local-Run': run,
      Host: 'evil.invalid', 'X-Forwarded-Host': 'evil.invalid', 'X-Forwarded-Proto': 'http',
    } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [issuer, issuerInit] = fetcher.mock.calls[0]!;
    expect(issuer.searchParams.get('audience')).toBe(`${origin}/v3-runner`);
    expect(issuerInit.redirect).toBe('error');
    const [apiUrl, apiInit] = fetcher.mock.calls[1]!;
    expect(apiUrl.origin).toBe('https://xvyin-v3-test.pages.dev');
    expect(apiInit.redirect).toBe('error');
    expect(apiInit.headers.get('Origin')).toBe(origin);
    expect(apiInit.headers.get('Authorization')).toBe('Bearer header.payload.signature');
    for (const name of ['Cookie', 'X-CSRF-Token', 'X-Xvyin-Local-Run', 'Host', 'X-Forwarded-Host', 'X-Forwarded-Proto']) expect(apiInit.headers.has(name)).toBe(false);
  });

  it.each(approvedOrigins)('still requires GitHub OIDC for %s when using the fixed Pages entry', async origin => {
    const fetcher = vi.fn();
    const client = createRunnerTransport({ origin, mode: 'github', localRunId: run, environment: {}, fetch: fetcher });
    await expect(client.request(internalPath)).rejects.toMatchObject({ code: 'OIDC_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(approvedOrigins)('keeps local administrator requests on %s with local authentication only', async origin => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { accepted: true } }));
    const client = createRunnerTransport({ origin, mode: 'local', localRunId: run, credentials, environment, fetch: fetcher });
    await client.request(internalPath + '/claim', { method: 'POST', body: '{}' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url.href).toBe(origin + internalPath + '/claim');
    expect(init.headers.get('Origin')).toBe(origin);
    expect(init.headers.get('Cookie')).toBe(credentials.cookie);
    expect(init.headers.get('X-CSRF-Token')).toBe(credentials.csrfToken);
    expect(init.headers.get('X-Xvyin-Local-Run')).toBe(run);
    expect(init.headers.has('Authorization')).toBe(false);
    expect(init.redirect).toBe('error');
  });

  it('preserves successful binary media source streaming', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const client = createRunnerTransport({ origin: 'https://test.xvyin.com', mode: 'local', localRunId: run, credentials,
      fetch: vi.fn().mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })),
    });
    expect(new Uint8Array(await (await client.request('/api/v1/internal/processing/id/source')).arrayBuffer())).toEqual(bytes);
  });

  it('rejects a successful HTML gateway page before a media runner can parse or save it', async () => {
    const client = createRunnerTransport({ origin: 'https://test.xvyin.com', mode: 'local', localRunId: run, credentials,
      fetch: vi.fn().mockResolvedValue(new Response('<html>PRIVATE LOGIN PAGE</html>', { headers: { 'content-type': 'text/html' } })),
    });
    await expect(client.request('/api/v1/internal/processing/id/source')).rejects.toMatchObject({ code: 'NON_JSON_RESPONSE' });
  });
});

describe('safe runner edge-error classification', () => {
  it('classifies a Cloudflare challenge without retrying it or exposing its HTML', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('<html>PRIVATE CHALLENGE BODY private-token</html>')); }, cancel });
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }));
    const client = new RunnerClient('https://test.xvyin.com', { mode: 'local', localRunId: run, jobId: randomUUID() }, credentials, fetcher);
    const error = await client.request('').catch(error => error);
    expect(error).toMatchObject({ code: 'CLOUDFLARE_CHALLENGE' });
    expect(String(error)).not.toMatch(/PRIVATE|private-token/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(deterministicFailure(error)).toBeNull();
  });

  it.each([200, 403])('classifies an HTTP %s HTML response separately from malformed JSON', async status => {
    const client = new RunnerClient('https://test.xvyin.com', { mode: 'local', localRunId: run, jobId: randomUUID() }, credentials,
      vi.fn().mockResolvedValue(new Response('<html>PRIVATE UPSTREAM BODY</html>', { status, headers: { 'content-type': 'text/html; charset=utf-8' } })));
    const error = await client.request('').catch(error => error);
    expect(error).toMatchObject({ code: 'NON_JSON_RESPONSE' });
    expect(String(error)).not.toContain('PRIVATE UPSTREAM BODY');
    expect(deterministicFailure(error)).toBeNull();
  });

  it('keeps malformed JSON classified without revealing JSON content', async () => {
    const client = new RunnerClient('https://test.xvyin.com', { mode: 'local', localRunId: run, jobId: randomUUID() }, credentials,
      vi.fn().mockResolvedValue(new Response('{"secret":"PRIVATE JSON"', { headers: { 'content-type': 'application/json' } })));
    const error = await client.request('').catch(error => error);
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(String(error)).not.toContain('PRIVATE JSON');
  });
});
