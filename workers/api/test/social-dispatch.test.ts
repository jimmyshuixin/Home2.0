import { describe, expect, it, vi } from 'vitest';
import { dispatchGitHubSocial } from '../src/github';

describe('hourly social workflow dispatch', () => {
  it('targets only the reviewed workflow on main and never follows a redirect with authorization', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response(null, { status: 204 }));
    await dispatchGitHubSocial('test-server-token', fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/jimmyshuixin/Home2.0/actions/workflows/public-social-sync.yml/dispatches');
    expect(options?.redirect).toBe('manual');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({ ref: 'main' });
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer test-server-token');
  });
  it('fails closed without configuration or when GitHub rejects/redirects the request', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://other.test/' } }));
    await expect(dispatchGitHubSocial(undefined, fetcher)).rejects.toMatchObject({ code: 'SOCIAL_SYNC_NOT_CONFIGURED' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(dispatchGitHubSocial('test-server-token', fetcher)).rejects.toMatchObject({ code: 'SOCIAL_SYNC_DISPATCH_FAILED' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
