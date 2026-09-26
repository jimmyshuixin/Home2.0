import { beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { verifySocialSyncRunner, SOCIAL_SYNC_TRUST } from '../src/social-sync-auth';

const now = Date.UTC(2026, 8, 26, 15), second = now / 1000, t = SOCIAL_SYNC_TRUST;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => { keys = await generateKeyPair('RS256'); });
const base = (): JWTPayload => ({
  iss: 'https://token.actions.githubusercontent.com', aud: t.audience, sub: `repo:${t.repository}:ref:${t.ref}`, iat: second, nbf: second, exp: second + 300,
  repository: t.repository, repository_id: t.repositoryId, repository_owner: t.owner, repository_owner_id: t.ownerId, repository_visibility: 'public',
  ref: t.ref, ref_type: 'branch', event_name: 'workflow_dispatch', runner_environment: 'github-hosted', workflow_ref: `${t.repository}/.github/workflows/${t.workflow}@${t.ref}`,
  workflow_sha: 'a'.repeat(40), sha: 'a'.repeat(40), run_id: '123456', run_attempt: '1',
});
async function verify(change: JWTPayload = {}, key?: JWTVerifyGetKey) {
  const token = await new SignJWT({ ...base(), ...change }).setProtectedHeader({ alg: 'RS256' }).sign(keys.privateKey);
  return verifySocialSyncRunner(new Request('https://xvyin.com/api/v1/internal/social-sync/claim', { headers: { authorization: `Bearer ${token}` } }), { key: key || (async () => keys.publicKey), now });
}
describe('dedicated social workflow OIDC trust', () => {
  it('accepts both standard subject formats for dispatched default-branch runs without pinning future commits', async () => {
    expect(await verify()).toEqual({ runId: 'github-123456', runAttempt: '1', codeSha: 'a'.repeat(40) });
    expect(await verify({ sub: `repo:${t.owner}@${t.ownerId}/Home2.0@${t.repositoryId}:ref:${t.ref}`, event_name: 'workflow_dispatch', sha: 'b'.repeat(40), workflow_sha: 'b'.repeat(40), run_attempt: '2' })).toMatchObject({ runAttempt: '2', codeSha: 'b'.repeat(40) });
  });
  it.each([
    ['repository', 'other/Home2.0'], ['repository_id', '999'], ['repository_owner_id', '999'], ['repository_owner', 'other'], ['repository_visibility', 'private'],
    ['ref', 'refs/heads/codex/v3-production'], ['ref_type', 'tag'], ['event_name', 'push'], ['event_name', 'pull_request'], ['event_name', 'schedule'],
    ['runner_environment', 'self-hosted'], ['workflow_ref', `${t.repository}/.github/workflows/v3-content.yml@${t.ref}`], ['workflow_sha', 'b'.repeat(40)],
    ['job_workflow_ref', `${t.repository}/.github/workflows/reused.yml@${t.ref}`], ['sub', `repo:${t.repository}:environment:production`],
    ['aud', 'https://xvyin.com/v3-runner'], ['iss', 'https://attacker.invalid'], ['exp', second - 1], ['iat', second - 601], ['nbf', second + 1],
    ['run_id', '../escape'], ['run_attempt', '0'], ['sha', 'invalid'],
  ])('rejects unauthorized %s = %s', async (field, value) => {
    await expect(verify({ [field]: value })).rejects.toMatchObject({ code: 'SOCIAL_SYNC_UNAUTHORIZED' });
  });
  it('rejects missing authorization before any key lookup', async () => {
    await expect(verifySocialSyncRunner(new Request('https://xvyin.com/'))).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a token with additional audiences even if the expected audience is included', async () => {
    await expect(verify({ aud: [t.audience, 'https://other.invalid'] })).rejects.toMatchObject({ code: 'SOCIAL_SYNC_UNAUTHORIZED' });
  });
  it('accepts direct-workflow job claims only when both identify the exact current trusted workflow and commit', async () => {
    const workflow = `${t.repository}/.github/workflows/${t.workflow}@${t.ref}`;
    expect(await verify({ job_workflow_ref: workflow, job_workflow_sha: 'a'.repeat(40) })).toEqual({ runId: 'github-123456', runAttempt: '1', codeSha: 'a'.repeat(40) });
    expect(await verify({ sha: 'b'.repeat(40), workflow_sha: 'b'.repeat(40), job_workflow_ref: workflow, job_workflow_sha: 'b'.repeat(40) })).toMatchObject({ codeSha: 'b'.repeat(40) });
  });
  it.each([
    { job_workflow_ref: `${t.repository}/.github/workflows/reused.yml@${t.ref}`, job_workflow_sha: 'a'.repeat(40) },
    { job_workflow_ref: `${t.repository}/.github/workflows/${t.workflow}@refs/heads/other`, job_workflow_sha: 'a'.repeat(40) },
    { job_workflow_ref: `${t.repository}/.github/workflows/${t.workflow}@${t.ref}`, job_workflow_sha: 'b'.repeat(40) },
    { job_workflow_ref: `${t.repository}/.github/workflows/${t.workflow}@${t.ref}` },
    { job_workflow_sha: 'a'.repeat(40) },
    { job_workflow_ref: '', job_workflow_sha: 'a'.repeat(40) },
    { job_workflow_ref: `${t.repository}/.github/workflows/${t.workflow}@${t.ref}`, job_workflow_sha: '' },
    { job_workflow_ref: null, job_workflow_sha: null },
    { job_workflow_ref: null }, { job_workflow_sha: null },
    { job_workflow_ref: '', job_workflow_sha: '' },
  ])('rejects different, incomplete or empty direct-workflow job claims (%j)', async claims => {
    await expect(verify(claims)).rejects.toMatchObject({ code: 'SOCIAL_SYNC_UNAUTHORIZED' });
  });
  it.each([
    [{ repository_id: 'wrong' }, 'repository'], [{ event_name: 'push' }, 'source'],
    [{ job_workflow_sha: 'a'.repeat(40) }, 'workflow'], [{ run_attempt: '0' }, 'identity'],
  ] as const)('only exposes a fixed stage for a signed identity mismatch (%s)', async (claims, stage) => {
    await expect(verify(claims)).rejects.toMatchObject({ status: 403, fields: { stage: [stage], reason: ['mismatch'] } });
  });
  it.each([
    ['ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'signature'], ['ERR_JWT_CLAIM_VALIDATION_FAILED', 'claim'], ['ERR_JWT_EXPIRED', 'claim'],
    ['ERR_JOSE_GENERIC', 'jwks-fetch'], ['ERR_JWKS_TIMEOUT', 'timeout'], ['ERR_JWKS_NO_MATCHING_KEY', 'no-key'],
    ['ERR_JWK_INVALID', 'invalid-key'], ['ERR_JWKS_INVALID', 'invalid-key'], ['ERR_JWKS_MULTIPLE_MATCHING_KEYS', 'invalid-key'],
    ['ERR_JOSE_ALG_NOT_ALLOWED', 'unsupported'], ['ERR_JOSE_NOT_SUPPORTED', 'unsupported'], ['ERR_JWS_INVALID', 'invalid-token'], ['ERR_JWT_INVALID', 'invalid-token'],
    ['arbitrary-secret-code', 'unknown'], ['__proto__', 'unknown'],
  ])('maps only allowlisted signature error codes (%s) without leaking error details', async (code, reason) => {
    const secret = 'private-token-and-payload-fixture';
    const error = await verify({}, async () => { throw Object.assign(new Error(secret), { code, payload: { private: secret }, cause: secret }); }).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 403, message: '公开资料同步来源认证失败', fields: { stage: ['signature'], reason: [reason] } });
    expect(JSON.stringify(error)).not.toContain(secret); expect(JSON.stringify(error)).not.toContain(code);
  });
  it('classifies real JOSE claim failures without exposing the offending value', async () => {
    await expect(verify({ aud: 'private-value-not-to-return' })).rejects.toMatchObject({ fields: { stage: ['signature'], reason: ['claim'], claim: ['aud'] } });
    await expect(verify({ exp: second - 1 })).rejects.toMatchObject({ fields: { stage: ['signature'], reason: ['claim'], claim: ['exp'] } });
  });
  it('never returns a non-allowlisted claim name or claims attached to an unrelated error', async () => {
    for (const details of [{ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', claim: 'private-claim-name' }, { code: 'ERR_JOSE_GENERIC', claim: 'aud' }]) {
      const error = await verify({}, async () => { throw Object.assign(new Error('private detail'), details); }).catch((value: unknown) => value);
      expect(error).not.toHaveProperty('fields.claim'); expect(JSON.stringify(error)).not.toContain('private');
    }
  });
});
