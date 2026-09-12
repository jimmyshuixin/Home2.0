import { describe, expect, it } from 'vitest';
import { mediaRunnerFailure, MediaRunnerError } from '../media-runner';
import { PublishError } from '../publish';

describe('media CLI safe shared-transport errors', () => {
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
