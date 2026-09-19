import { afterEach, describe, expect, it, vi } from 'vitest';
import { mediaRunnerCli, mediaRunnerFailure, MediaRunnerError } from '../media-runner';
import { PublishError } from '../publish';
import * as photography from '../photo-metadata-runner';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('media CLI safe shared-transport errors', () => {
  it('requires the existing runner origin and authentication before dispatching the reserved photography target', async () => {
    const delegated = vi.spyOn(photography, 'photographyRunnerCli').mockResolvedValue(undefined);
    vi.stubEnv('GITHUB_ACTIONS',''); vi.stubEnv('GITHUB_RUN_ID','');
    await expect(mediaRunnerCli(['--asset','maintenance-photography-v1','--origin','https://xvyin.com'])).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    expect(delegated).not.toHaveBeenCalled();
    vi.stubEnv('GITHUB_ACTIONS','true'); vi.stubEnv('GITHUB_RUN_ID','12345');
    await expect(mediaRunnerCli(['--asset','maintenance-photography-v1','--origin','https://untrusted.invalid'])).rejects.toMatchObject({code:'INVALID_ORIGIN'});
    expect(delegated).not.toHaveBeenCalled();
    await mediaRunnerCli(['--asset','maintenance-photography-v1','--origin','https://xvyin.com']);
    expect(delegated).toHaveBeenCalledExactlyOnceWith(['--origin','https://xvyin.com']);
    expect(mediaRunnerFailure(new photography.PhotographyRunnerError('BACKFILL_INCOMPLETE')).code).toBe('BACKFILL_INCOMPLETE');
  });
  it.each(['CLOUDFLARE_CHALLENGE', 'NON_JSON_RESPONSE', 'INVALID_RESPONSE', 'NETWORK_ERROR', 'OIDC_UNAVAILABLE'])('preserves %s without printing the underlying message', code => {
    const result = mediaRunnerFailure(new PublishError(code, '<html>PRIVATE RESPONSE bearer-secret cookie-secret</html>'));
    expect(result.code).toBe(code);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|bearer-secret|cookie-secret|html/);
  });

  it('retains media error categories while hiding provider messages', () => {
    expect(mediaRunnerFailure(new MediaRunnerError('SOURCE_HASH_MISMATCH', 'PRIVATE SOURCE NAME')).code).toBe('SOURCE_HASH_MISMATCH');
    expect(JSON.stringify(mediaRunnerFailure(new MediaRunnerError('SOURCE_HASH_MISMATCH', 'PRIVATE SOURCE NAME')))).not.toContain('PRIVATE SOURCE NAME');
  });

  it('does not trust code properties on unknown exceptions or unsafe category strings', () => {
    const unknown = Object.assign(new Error('PRIVATE exception'), { code: 'CLOUDFLARE_CHALLENGE' });
    expect(mediaRunnerFailure(unknown).code).toBe('MEDIA_RUNNER_FAILED');
    expect(mediaRunnerFailure(new PublishError('SECRET\nprivate value', 'PRIVATE details')).code).toBe('MEDIA_RUNNER_FAILED');
  });
});
