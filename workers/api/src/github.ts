import { createRemoteJWKSet, jwtVerify } from 'jose';
import { assert, ApiError } from './errors';
import type { ReleaseJob } from './releases';
export async function dispatchGitHubMedia(assetId: string, config: { token: string; repository: string; ref: string; origin: string }): Promise<void> {
  assert(config.token && /^[\w.-]+\/[\w.-]+$/u.test(config.repository) && /^[A-Za-z0-9_-]+$/u.test(assetId), 'MEDIA_NOT_CONFIGURED', 503, '自动媒体处理尚未配置');
  const response = await fetch(`https://api.github.com/repos/${config.repository}/actions/workflows/v3-media.yml/dispatches`, { method: 'POST', headers: { authorization: `Bearer ${config.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'xvyin-v3', 'x-github-api-version': '2022-11-28' }, body: JSON.stringify({ ref: config.ref.replace(/^refs\/heads\//u, ''), inputs: { asset_id: assetId, api_origin: config.origin } }), signal: AbortSignal.timeout(15000), redirect: 'manual' });
  await response.body?.cancel();
  assert(response.status === 204, 'MEDIA_DISPATCH_FAILED', 503, '媒体已上传，自动处理派发未确认，可在后台重试处理');
}
export async function verifyGitHubRunner(request: Request, config: { repository: string; ref: string; audience: string }): Promise<{ runId: string; codeSha: string }> {
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/u)?.[1];
  assert(token && token.length <= 16000, 'RUNNER_UNAUTHORIZED', 401, '构建执行器认证失败');
  try {
    const jwks = createRemoteJWKSet(new URL('https://token.actions.githubusercontent.com/.well-known/jwks'), { timeoutDuration: 10000 });
    const { payload } = await jwtVerify(token, jwks, { issuer: 'https://token.actions.githubusercontent.com', audience: config.audience, algorithms: ['RS256'], maxTokenAge: '10m' });
    assert(payload.repository === config.repository && payload.ref === config.ref && payload.event_name === 'workflow_dispatch', 'RUNNER_UNAUTHORIZED', 403, '构建来源不符');
    const allowedWorkflows = ['v3-content.yml', 'v3-media.yml'].map(name => `${config.repository}/.github/workflows/${name}@${config.ref}`);
    assert(typeof payload.workflow_ref === 'string' && allowedWorkflows.includes(payload.workflow_ref) && payload.workflow_sha === payload.sha, 'RUNNER_UNAUTHORIZED', 403, '构建工作流或代码版本不符');
    assert(typeof payload.run_id === 'string' && /^\d+$/u.test(payload.run_id) && typeof payload.sha === 'string' && /^[a-f0-9]{40}$/u.test(payload.sha), 'RUNNER_UNAUTHORIZED', 403, '构建身份不完整');
    return { runId: `github-${payload.run_id}`, codeSha: payload.sha };
  } catch { throw new ApiError('RUNNER_UNAUTHORIZED', 403, '构建执行器认证失败'); }
}
export async function dispatchGitHubBuild(job: ReleaseJob, config: { token: string; repository: string; ref: string; origin: string }): Promise<void> {
  assert(config.token && /^[\w.-]+\/[\w.-]+$/u.test(config.repository), 'BUILD_NOT_CONFIGURED', 503, '自动构建尚未配置，可使用已认证的本地发布命令');
  const response = await fetch(`https://api.github.com/repos/${config.repository}/actions/workflows/v3-content.yml/dispatches`, { method: 'POST', headers: { authorization: `Bearer ${config.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'xvyin-v3', 'x-github-api-version': '2022-11-28' }, body: JSON.stringify({ ref: config.ref.replace(/^refs\/heads\//u, ''), inputs: { job_id: job.id, api_origin: config.origin, code_sha: job.codeSha } }), signal: AbortSignal.timeout(15000), redirect: 'manual' });
  await response.body?.cancel();
  assert(response.status === 204, 'BUILD_DISPATCH_FAILED', 503, '自动构建派发未确认，任务仍在队列中，可重试或使用本地执行器');
}
