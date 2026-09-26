import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ApiError, assert } from './errors';

// Separate from publication/media runner trust: only this reviewed default-branch workflow may import public social data.
export const SOCIAL_SYNC_TRUST = {
  repository: 'jimmyshuixin/Home2.0', repositoryId: '1252970286', owner: 'jimmyshuixin', ownerId: '121843277',
  ref: 'refs/heads/main', workflow: 'public-social-sync.yml', audience: 'https://xvyin.com/public-social-sync',
} as const;
export interface SocialSyncIdentity { runId: string; runAttempt: string; codeSha: string }
const jwks = createRemoteJWKSet(new URL('https://token.actions.githubusercontent.com/.well-known/jwks'), { timeoutDuration: 5000 });
export async function verifySocialSyncRunner(request: Request, options: { key?: JWTVerifyGetKey; now?: number } = {}): Promise<SocialSyncIdentity> {
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/u)?.[1];
  assert(token && token.length <= 16000, 'SOCIAL_SYNC_UNAUTHORIZED', 401, '公开资料同步来源未获授权');
  try {
    const trust = SOCIAL_SYNC_TRUST;
    const { payload } = await jwtVerify(token, options.key || jwks, { issuer: 'https://token.actions.githubusercontent.com', audience: trust.audience, algorithms: ['RS256'], maxTokenAge: '10m', requiredClaims: ['exp', 'iat', 'nbf', 'sub'], ...(options.now === undefined ? {} : { currentDate: new Date(options.now) }) });
    const subjects = [`repo:${trust.repository}:ref:${trust.ref}`, `repo:${trust.owner}@${trust.ownerId}/Home2.0@${trust.repositoryId}:ref:${trust.ref}`];
    assert(payload.repository === trust.repository && payload.repository_id === trust.repositoryId && payload.repository_owner === trust.owner && payload.repository_owner_id === trust.ownerId && payload.repository_visibility === 'public' && subjects.includes(payload.sub || ''), 'SOCIAL_SYNC_UNAUTHORIZED', 403, '公开资料同步仓库不符');
    assert(payload.aud === trust.audience && payload.ref === trust.ref && payload.ref_type === 'branch' && payload.event_name === 'workflow_dispatch' && payload.runner_environment === 'github-hosted', 'SOCIAL_SYNC_UNAUTHORIZED', 403, '公开资料同步来源不符');
    assert(payload.workflow_ref === `${trust.repository}/.github/workflows/${trust.workflow}@${trust.ref}` && payload.workflow_sha === payload.sha && payload.job_workflow_ref === undefined, 'SOCIAL_SYNC_UNAUTHORIZED', 403, '公开资料同步工作流不符');
    assert(typeof payload.run_id === 'string' && /^[1-9]\d{0,24}$/u.test(payload.run_id) && typeof payload.run_attempt === 'string' && /^[1-9]\d{0,8}$/u.test(payload.run_attempt) && typeof payload.sha === 'string' && /^[a-f0-9]{40}$/u.test(payload.sha), 'SOCIAL_SYNC_UNAUTHORIZED', 403, '公开资料同步身份不完整');
    return { runId: `github-${payload.run_id}`, runAttempt: payload.run_attempt, codeSha: payload.sha };
  } catch { throw new ApiError('SOCIAL_SYNC_UNAUTHORIZED', 403, '公开资料同步来源认证失败'); }
}
