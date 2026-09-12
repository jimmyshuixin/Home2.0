import type { AuthIdentity, AuthProvider } from './auth';
import type { Store } from './store/types';
import { assert } from './errors';
import { cookieValue, randomToken, secretEqual, sha256 } from './security';
export interface Session extends AuthIdentity { id: string; csrfToken: string; createdAt: number; lastSeenAt: number; expiresAt: number; epoch: number }
export interface SessionResult { session: Session; cookie: string }
export class Sessions {
  readonly cookieName: string;
  constructor(private readonly store: Store, private readonly auth: AuthProvider, private readonly secure: boolean, private readonly now: () => number) {
    this.cookieName = secure ? '__Host-xvyin_session' : 'xvyin_local_session';
  }
  async create(identity: AuthIdentity): Promise<SessionResult> {
    const token = randomToken(), id = await sha256(token), now = this.now();
    const session = await this.store.transaction(async tx => {
      const epoch = (await tx.get<{ epoch: number }>(`auth_epochs/${identity.uid}`))?.epoch || 0;
      const value: Session = { ...identity, id, csrfToken: randomToken(), createdAt: now, lastSeenAt: now, expiresAt: now + 12 * 3600_000, epoch };
      tx.put(`sessions/${id}`, value); return value;
    });
    return { session, cookie: this.cookie(token, 12 * 3600) };
  }
  async require(request: Request, write = false): Promise<Session> {
    const token = cookieValue(request, this.cookieName);
    assert(token && /^[A-Za-z0-9_-]{43}$/u.test(token), 'UNAUTHENTICATED', 401, '请先登录管理员账号');
    const id = await sha256(token), now = this.now();
    const session = await this.store.get<Session>(`sessions/${id}`);
    assert(session && session.expiresAt > now && session.lastSeenAt + 30 * 60_000 > now, 'SESSION_EXPIRED', 401, '登录已过期，请重新登录');
    await this.auth.assertSession({ uid: session.uid, authTime: session.authTime });
    // The final authorization decision follows provider I/O and observes local
    // logout/revocation atomically. Already-authorized requests are not cancelled.
    return this.store.transaction(async tx => {
      const [current, revision] = await Promise.all([tx.get<Session>(`sessions/${id}`), tx.get<{ epoch: number }>(`auth_epochs/${session.uid}`)]);
      const checkedAt = this.now();
      assert(current && current.uid === session.uid && current.authTime === session.authTime, 'SESSION_REVOKED', 401, '登录已撤销，请重新登录');
      assert(current.expiresAt > checkedAt && current.lastSeenAt + 30 * 60_000 > checkedAt, 'SESSION_EXPIRED', 401, '登录已过期，请重新登录');
      assert(current.epoch === (revision?.epoch || 0), 'SESSION_REVOKED', 401, '登录已撤销，请重新登录');
      if (write) assert(await secretEqual(current.csrfToken, request.headers.get('x-csrf-token') || ''), 'CSRF_REJECTED', 403, '页面验证已失效，请刷新后重试');
      const next = checkedAt - current.lastSeenAt >= 60_000 ? { ...current, lastSeenAt: checkedAt } : current;
      if (next !== current) tx.put(`sessions/${id}`, next);
      return next;
    });
  }
  async revokeAll(uid: string): Promise<void> {
    await this.store.transaction(async tx => {
      const current = await tx.get<{ epoch: number }>(`auth_epochs/${uid}`);
      tx.put(`auth_epochs/${uid}`, { epoch: (current?.epoch || 0) + 1 });
    });
  }
  async logout(session: Session): Promise<string> {
    await this.store.transaction(async tx => { await tx.get(`sessions/${session.id}`); tx.delete(`sessions/${session.id}`); });
    return this.cookie('', 0);
  }
  private cookie(token: string, maxAge: number): string {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`;
  }
}
