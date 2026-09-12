import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import {
  AuthError,
  type AuthIdentity,
  type AuthProvider,
  type AuthProviderDependencies,
  type FirebasePasswordConfig,
} from './types';

const IDENTITY_ORIGIN = 'https://identitytoolkit.googleapis.com';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const RESPONSE_LIMIT = 128 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const RECENT_AUTH_SECONDS = 300;
type JsonRecord = Record<string, unknown>;
type Operation = 'login' | 'lookup' | 'update' | 'reset' | 'send-reset';

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function validFirebasePasswordConfig(value: unknown): value is FirebasePasswordConfig {
  if (!isRecord(value)) return false;
  const { projectId, apiKey, adminUid, adminUsername, adminEmail, passwordResetUrl } = value;
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) return false;
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(apiKey)) return false;
  if (typeof adminUid !== 'string' || adminUid.length < 1 || adminUid.length > 128 || /\s/.test(adminUid)) return false;
  if (typeof adminUsername !== 'string' || adminUsername.length < 1 || adminUsername.length > 64 || adminUsername !== adminUsername.trim() || /[\u0000-\u001f\u007f]/.test(adminUsername)) return false;
  if (typeof adminEmail !== 'string' || adminEmail.length > 254 || adminEmail !== adminEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) return false;
  if (typeof passwordResetUrl !== 'string') return false;
  try {
    const url = new URL(passwordResetUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) return false;
  } catch {
    return false;
  }
  return true;
}

function assertNewPassword(password: string): void {
  if (typeof password !== 'string' || password.length > 256) throw new AuthError('AUTH_PASSWORD_POLICY');
  const length = [...password].length;
  if (length < 15 || length > 128) throw new AuthError('AUTH_PASSWORD_POLICY');
}

function validPasswordInput(password: unknown): password is string {
  return typeof password === 'string' && password.length > 0 && password.length <= 1024;
}

function errorForResponse(status: number, body: unknown, operation: Operation): AuthError {
  const detail = isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string'
    ? body.error.message.split(' : ')[0] ?? ''
    : '';
  if (status === 429 || detail === 'TOO_MANY_ATTEMPTS_TRY_LATER' || detail === 'QUOTA_EXCEEDED') return new AuthError('AUTH_RATE_LIMITED');
  if (operation === 'login' && ['INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'USER_DISABLED'].includes(detail)) return new AuthError('AUTH_INVALID_CREDENTIALS');
  if (operation === 'reset' && ['INVALID_OOB_CODE', 'EXPIRED_OOB_CODE', 'EMAIL_NOT_FOUND', 'USER_DISABLED'].includes(detail)) return new AuthError('AUTH_INVALID_RESET_CODE');
  if ((operation === 'update' || operation === 'reset') && (detail === 'WEAK_PASSWORD' || detail === 'PASSWORD_DOES_NOT_MEET_REQUIREMENTS')) return new AuthError('AUTH_PASSWORD_POLICY');
  if (operation === 'update' && ['TOKEN_EXPIRED', 'INVALID_ID_TOKEN', 'USER_DISABLED', 'CREDENTIAL_TOO_OLD_LOGIN_AGAIN'].includes(detail)) return new AuthError('AUTH_SESSION_REVOKED');
  return new AuthError('AUTH_UNAVAILABLE');
}

/**
 * Passwords are verified by Firebase, never hashed or stored by this application.
 * The router supplies CSRF/rate limiting; SessionRepository stores opaque sessions.
 * All URLs are fixed or deployment configuration, never supplied by a caller.
 */
export class FirebasePasswordProvider implements AuthProvider {
  readonly #config: FirebasePasswordConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #getGoogleAccessToken: () => Promise<string>;

  constructor(config: FirebasePasswordConfig, dependencies: AuthProviderDependencies) {
    if (!validFirebasePasswordConfig(config) || typeof dependencies?.getGoogleAccessToken !== 'function') throw new AuthError('AUTH_NOT_CONFIGURED');
    this.#config = { ...config, adminEmail: normalizedEmail(config.adminEmail) };
    this.#fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = dependencies.now ?? Date.now;
    this.#getGoogleAccessToken = dependencies.getGoogleAccessToken;
  }

  #nowSeconds(): number {
    const value = this.#now();
    if (!Number.isFinite(value) || value <= 0) throw new AuthError('AUTH_UNAVAILABLE');
    return Math.floor(value / 1000);
  }

  async #request(url: string, operation: Operation, body?: JsonRecord, accessToken?: string): Promise<JsonRecord> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.#fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.body) throw new AuthError('AUTH_UNAVAILABLE');
      const declaredLength = response.headers.get('content-length');
      if (declaredLength && Number(declaredLength) > RESPONSE_LIMIT) {
        await response.body.cancel();
        throw new AuthError('AUTH_UNAVAILABLE');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > RESPONSE_LIMIT) {
            await reader.cancel();
            throw new AuthError('AUTH_UNAVAILABLE');
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      let json: unknown;
      try { json = JSON.parse(text); } catch { throw new AuthError('AUTH_UNAVAILABLE'); }
      if (!response.ok) throw errorForResponse(response.status, json, operation);
      if (!isRecord(json)) throw new AuthError('AUTH_UNAVAILABLE');
      return json;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError('AUTH_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }

  async #publicApi(method: string, operation: Operation, body: JsonRecord): Promise<JsonRecord> {
    return this.#request(`${IDENTITY_ORIGIN}/v1/accounts:${method}?key=${encodeURIComponent(this.#config.apiKey)}`, operation, body);
  }

  async #adminApi(method: string, operation: Operation, body: JsonRecord): Promise<JsonRecord> {
    let accessToken: string;
    try { accessToken = await this.#getGoogleAccessToken(); } catch { throw new AuthError('AUTH_UNAVAILABLE'); }
    if (typeof accessToken !== 'string' || !accessToken || /[\r\n]/.test(accessToken)) throw new AuthError('AUTH_NOT_CONFIGURED');
    return this.#request(`${IDENTITY_ORIGIN}/v1/projects/${this.#config.projectId}/accounts:${method}`, operation, body, accessToken);
  }

  async #verifyIdToken(token: string): Promise<AuthIdentity> {
    if (token.length > 16_384) throw new AuthError('AUTH_INVALID_CREDENTIALS');
    const jwks = await this.#request(JWKS_URL, 'lookup');
    if (!Array.isArray(jwks.keys) || jwks.keys.length < 1 || jwks.keys.length > 20) throw new AuthError('AUTH_UNAVAILABLE');
    const keySet: JSONWebKeySet = { keys: jwks.keys.map((key: unknown) => {
      if (!isRecord(key) || key.kty !== 'RSA' || typeof key.kid !== 'string' || !key.kid || typeof key.n !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key.n) || typeof key.e !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key.e) || (key.alg !== undefined && key.alg !== 'RS256') || (key.use !== undefined && key.use !== 'sig')) throw new AuthError('AUTH_UNAVAILABLE');
      return { kty: 'RSA', kid: key.kid, n: key.n, e: key.e, alg: 'RS256', use: 'sig' };
    }) };
    try {
      const now = this.#nowSeconds();
      const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(keySet), {
        algorithms: ['RS256'],
        issuer: `https://securetoken.google.com/${this.#config.projectId}`,
        audience: this.#config.projectId,
        requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time'],
        currentDate: new Date(now * 1000),
        clockTolerance: 0,
      });
      if (!protectedHeader.kid || payload.sub !== this.#config.adminUid || payload.aud !== this.#config.projectId || !Number.isInteger(payload.iat) || payload.iat! > now || !Number.isInteger(payload.auth_time) || typeof payload.auth_time !== 'number' || payload.auth_time <= 0 || payload.auth_time > now || payload.auth_time > payload.iat! || now - payload.auth_time > RECENT_AUTH_SECONDS) throw new AuthError('AUTH_INVALID_CREDENTIALS');
      return { uid: payload.sub, authTime: payload.auth_time };
    } catch {
      throw new AuthError('AUTH_INVALID_CREDENTIALS');
    }
  }

  async #lookupAdmin(): Promise<JsonRecord> {
    const result = await this.#adminApi('lookup', 'lookup', { localId: [this.#config.adminUid] });
    if (!Array.isArray(result.users) || result.users.length !== 1) throw new AuthError('AUTH_SESSION_REVOKED');
    const user: unknown = result.users[0];
    if (!isRecord(user) || user.localId !== this.#config.adminUid || user.disabled === true || typeof user.email !== 'string' || normalizedEmail(user.email) !== this.#config.adminEmail) throw new AuthError('AUTH_SESSION_REVOKED');
    return user;
  }

  async #authenticate(password: string): Promise<{ identity: AuthIdentity; idToken: string }> {
    if (!validPasswordInput(password)) throw new AuthError('AUTH_INVALID_CREDENTIALS');
    const result = await this.#publicApi('signInWithPassword', 'login', {
      email: this.#config.adminEmail, password, returnSecureToken: true,
    });
    if (result.localId !== this.#config.adminUid || typeof result.idToken !== 'string') throw new AuthError('AUTH_INVALID_CREDENTIALS');
    const identity = await this.#verifyIdToken(result.idToken);
    await this.assertSession(identity);
    return { identity, idToken: result.idToken };
  }

  async signIn(input: { username: string; password: string }): Promise<AuthIdentity> {
    if (input.username !== this.#config.adminUsername) throw new AuthError('AUTH_INVALID_CREDENTIALS');
    return (await this.#authenticate(input.password)).identity;
  }

  async assertSession(identity: AuthIdentity): Promise<void> {
    if (identity.uid !== this.#config.adminUid || !Number.isSafeInteger(identity.authTime) || identity.authTime <= 0 || identity.authTime > this.#nowSeconds()) throw new AuthError('AUTH_SESSION_REVOKED');
    const user = await this.#lookupAdmin();
    // Firebase accounts:lookup returns the minimum accepted auth_time as seconds.
    // A missing/malformed value cannot establish that an existing session is valid.
    if (typeof user.validSince !== 'string' || !/^\d{1,12}$/.test(user.validSince)) throw new AuthError('AUTH_UNAVAILABLE');
    if (identity.authTime < Number(user.validSince)) throw new AuthError('AUTH_SESSION_REVOKED');
  }

  async changePassword(input: { uid: string; currentPassword: string; newPassword: string }): Promise<void> {
    if (input.uid !== this.#config.adminUid) throw new AuthError('AUTH_SESSION_REVOKED');
    assertNewPassword(input.newPassword);
    const { idToken } = await this.#authenticate(input.currentPassword);
    const result = await this.#publicApi('update', 'update', { idToken, password: input.newPassword, returnSecureToken: true });
    if (result.localId !== this.#config.adminUid) throw new AuthError('AUTH_UNAVAILABLE');
    // Firebase password changes revoke older Firebase sessions. The caller MUST
    // revoke its own opaque sessions, including the current one, on success.
  }

  async requestPasswordReset(input: { username: string }): Promise<void> {
    // The route returns the same response for unknown usernames. It must rate-limit
    // recovery independently from sign-in, and must never accept a recipient email.
    if (input.username !== this.#config.adminUsername) return;
    await this.#lookupAdmin();
    await this.#publicApi('sendOobCode', 'send-reset', {
      requestType: 'PASSWORD_RESET', email: this.#config.adminEmail,
      continueUrl: this.#config.passwordResetUrl,
    });
  }

  async confirmPasswordReset(input: { code: string; newPassword: string }): Promise<{ uid: string }> {
    assertNewPassword(input.newPassword);
    if (typeof input.code !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(input.code)) throw new AuthError('AUTH_INVALID_RESET_CODE');
    const verified = await this.#publicApi('resetPassword', 'reset', { oobCode: input.code });
    if (typeof verified.email !== 'string' || normalizedEmail(verified.email) !== this.#config.adminEmail || verified.requestType !== 'PASSWORD_RESET') throw new AuthError('AUTH_INVALID_RESET_CODE');
    await this.#lookupAdmin();
    const result = await this.#publicApi('resetPassword', 'reset', { oobCode: input.code, newPassword: input.newPassword });
    if (typeof result.email !== 'string' || normalizedEmail(result.email) !== this.#config.adminEmail) throw new AuthError('AUTH_UNAVAILABLE');
    return { uid: this.#config.adminUid };
  }

  async revokeAllSessions(uid: string): Promise<void> {
    if (uid !== this.#config.adminUid) throw new AuthError('AUTH_SESSION_REVOKED');
    await this.#adminApi('update', 'update', { localId: uid, validSince: String(this.#nowSeconds()) });
    // Root's SessionRepository must also revoke immediately using its auth epoch:
    // Firebase auth_time/validSince have only second resolution.
  }
}
