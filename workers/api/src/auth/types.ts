/** Authentication proofs contain no provider tokens. authTime is Unix seconds. */
export interface AuthIdentity {
  uid: string;
  authTime: number;
}

export interface AuthProvider {
  signIn(input: { username: string; password: string }): Promise<AuthIdentity>;
  assertSession(identity: AuthIdentity): Promise<void>;
  changePassword(input: { uid: string; currentPassword: string; newPassword: string }): Promise<void>;
  requestPasswordReset(input: { username: string }): Promise<void>;
  confirmPasswordReset(input: { code: string; newPassword: string }): Promise<{ uid: string }>;
  revokeAllSessions(uid: string): Promise<void>;
}

export interface FirebasePasswordConfig {
  projectId: string;
  apiKey: string;
  adminUid: string;
  adminUsername: string;
  adminEmail: string;
  /** Must also be configured as the Firebase email template's custom action URL. */
  passwordResetUrl: string;
}

export interface AuthProviderDependencies {
  fetch?: typeof globalThis.fetch;
  /** Milliseconds since Unix epoch; injected for deterministic validation tests. */
  now?: () => number;
  /** OAuth token from a server credential with firebaseauth.users.get/update only. */
  getGoogleAccessToken: () => Promise<string>;
}

export type AuthErrorCode =
  | 'AUTH_NOT_CONFIGURED'
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_SESSION_REVOKED'
  | 'AUTH_INVALID_RESET_CODE'
  | 'AUTH_PASSWORD_POLICY'
  | 'AUTH_RATE_LIMITED'
  | 'AUTH_UNAVAILABLE';

const publicErrors: Record<AuthErrorCode, { status: number; message: string }> = {
  AUTH_NOT_CONFIGURED: { status: 503, message: '管理员认证尚未完成配置。' },
  AUTH_INVALID_CREDENTIALS: { status: 401, message: '账号或密码不正确。' },
  AUTH_SESSION_REVOKED: { status: 401, message: '登录已失效，请重新登录。' },
  AUTH_INVALID_RESET_CODE: { status: 400, message: '密码重置链接无效或已过期。' },
  AUTH_PASSWORD_POLICY: { status: 422, message: '新密码须为 15 至 128 个字符，并符合账号密码策略。' },
  AUTH_RATE_LIMITED: { status: 429, message: '尝试过于频繁，请稍后重试。' },
  AUTH_UNAVAILABLE: { status: 503, message: '认证服务暂时不可用，请稍后重试。' },
};

/** Deliberately carries no upstream body, request, token, password, or Error.cause. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;

  constructor(code: AuthErrorCode) {
    super(publicErrors[code].message);
    this.name = 'AuthError';
    this.code = code;
    this.status = publicErrors[code].status;
  }
}
