import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ advance: vi.fn(), analytics: vi.fn(), social: vi.fn() }));
vi.mock('../src/maintenance-expiry', () => ({ ExpiryMaintenance: class { advance() { return mocks.advance(); } } }));
vi.mock('../src/engagement', async original => ({ ...await original<typeof import('../src/engagement')>(), Engagement: class { cleanup() { return mocks.analytics(); } } }));
vi.mock('../src/store/firestore', () => ({ FirestoreStore: class {} }));
vi.mock('../src/store/google-oauth', async original => ({ ...await original<typeof import('../src/store/google-oauth')>(), createGoogleAccessTokenProvider: () => async () => 'local-test-token' }));
vi.mock('../src/github', async original => ({ ...await original<typeof import('../src/github')>(), dispatchGitHubSocial: mocks.social }));
import worker from '../src/index';

beforeEach(() => { vi.clearAllMocks(); mocks.advance.mockResolvedValue({}); mocks.analytics.mockResolvedValue(0); mocks.social.mockResolvedValue(undefined); });
async function invoke(cron: string) {
  const promises: Promise<unknown>[] = [];
  await worker.scheduled({ cron, scheduledTime: Date.UTC(2026, 8, 29), noRetry() {} } as ScheduledController,
    { GOOGLE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'local-project', client_email: 'local@example.invalid', private_key: 'local-only' }), FIREBASE_PROJECT_ID: 'local-project', FIRESTORE_DATABASE_ID: '(default)', PRIVACY_SALT: 'local-only', GITHUB_TOKEN: 'local-only' } as ApiEnv & { GITHUB_TOKEN: string },
    { waitUntil(promise: Promise<unknown>) { promises.push(promise); } } as ExecutionContext);
  return Promise.all(promises);
}
describe('scheduled maintenance isolation', () => {
  it('executes one expiry step for its cron and does not dispatch unrelated jobs', async () => {
    await invoke('7,22,37,52 * * * *');
    expect(mocks.advance).toHaveBeenCalledTimes(1); expect(mocks.analytics).not.toHaveBeenCalled(); expect(mocks.social).not.toHaveBeenCalled();
  });
  it('retains the existing daily analytics and hourly social schedules', async () => {
    await invoke('0 16 * * *'); await invoke('17 * * * *');
    expect(mocks.analytics).toHaveBeenCalledTimes(1); expect(mocks.social).toHaveBeenCalledTimes(1); expect(mocks.advance).not.toHaveBeenCalled();
  });
  it('ignores an unconfigured cron and reports an expiry failure through waitUntil', async () => {
    await invoke('* * * * *'); expect(mocks.advance).not.toHaveBeenCalled();
    mocks.advance.mockRejectedValue(new Error('isolated transient store failure'));
    await expect(invoke('7,22,37,52 * * * *')).rejects.toThrow('isolated transient store failure');
    expect(mocks.advance).toHaveBeenCalledTimes(1); expect(mocks.analytics).not.toHaveBeenCalled();
  });
});
