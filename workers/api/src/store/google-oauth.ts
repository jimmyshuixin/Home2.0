import { importPKCS8, SignJWT } from 'jose';
import { StoreError } from './types';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_OAUTH_SCOPES = {
  datastore: 'https://www.googleapis.com/auth/datastore',
  firebase: 'https://www.googleapis.com/auth/firebase',
  cloudPlatform: 'https://www.googleapis.com/auth/cloud-platform',
  identityToolkit: 'https://www.googleapis.com/auth/identitytoolkit',
} as const;
export type GoogleOAuthScope = typeof GOOGLE_OAUTH_SCOPES[keyof typeof GOOGLE_OAUTH_SCOPES];
export interface GoogleServiceAccountConfig { projectId: string; clientEmail: string; privateKey: string }
export interface GoogleOAuthOptions {
  scopes?: readonly GoogleOAuthScope[];
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
}
const SAFE_EXCEPTION_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'AbortError', 'TimeoutError', 'DataError', 'NotSupportedError', 'OperationError', 'InvalidAccessError', 'InvalidStateError', 'InvalidCharacterError', 'SecurityError']);
/** Only fixed platform exception names may enter diagnostics; never messages or arbitrary names. */
export function safeStoreExceptionName(error: unknown): string {
  try {
    const name = error instanceof Error ? error.name : '';
    return SAFE_EXCEPTION_NAMES.has(name) ? name : 'UnknownError';
  } catch { return 'UnknownError'; }
}

export function validServiceAccountConfig(config: GoogleServiceAccountConfig): boolean {
  return Boolean(config && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(config.projectId)
    && typeof config.clientEmail === 'string' && /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$/u.test(config.clientEmail)
    && typeof config.privateKey === 'string' && config.privateKey.length >= 1000 && config.privateKey.length <= 16_384
    && config.privateKey.includes('-----BEGIN PRIVATE KEY-----') && config.privateKey.includes('-----END PRIVATE KEY-----'));
}

/** Bounded even when the upstream omits or lies about Content-Length. Never logs the body. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new StoreError('STORE_UNAVAILABLE');
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    await response.body.cancel(); throw new StoreError('STORE_UNAVAILABLE');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0; let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new StoreError('STORE_UNAVAILABLE'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch { throw new StoreError('STORE_UNAVAILABLE'); }
  finally { reader.releaseLock(); }
}

/**
 * Construct inside each Worker request's dependency factory. Reuses token/key and
 * de-duplicates concurrent issuance within that request; no global I/O promise.
 */
export function createGoogleAccessTokenProvider(config: GoogleServiceAccountConfig, options: GoogleOAuthOptions = {}): () => Promise<string> {
  if (!validServiceAccountConfig(config)) throw new StoreError('STORE_NOT_CONFIGURED');
  const scopes = [...new Set(options.scopes ?? [GOOGLE_OAUTH_SCOPES.datastore])].sort();
  const allowed = new Set<string>(Object.values(GOOGLE_OAUTH_SCOPES));
  if (!scopes.length || scopes.some(scope => !allowed.has(scope))) throw new StoreError('STORE_NOT_CONFIGURED');
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new StoreError('STORE_NOT_CONFIGURED');
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const credential = { ...config, privateKey: config.privateKey.replace(/\\n/gu, '\n') };
  let signingKey: ReturnType<typeof importPKCS8> | null = null;
  let pending: Promise<string> | null = null;
  let cached: { token: string; expiresAt: number } | null = null;

  const nowSeconds = () => {
    const value = now();
    if (!Number.isFinite(value) || value <= 0) throw new StoreError('STORE_UNAVAILABLE');
    return Math.floor(value / 1000);
  };
  async function issue(): Promise<string> {
    const issuedAt = nowSeconds();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let stage: 'key_import' | 'jwt_sign' | 'token_fetch' | 'token_response' | 'token_validation' = 'key_import';
    let status: number | null = null;
    try {
      signingKey ??= importPKCS8(credential.privateKey, 'RS256');
      const key = await signingKey;
      stage = 'jwt_sign';
      const assertion = await new SignJWT({ scope: scopes.join(' ') })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .setIssuer(credential.clientEmail).setAudience(TOKEN_URL)
        .setIssuedAt(issuedAt).setExpirationTime(issuedAt + 3600)
        .sign(key);
      const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
      stage = 'token_fetch';
      const response = await fetcher(TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(), redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      status = response.status;
      stage = 'token_response';
      const result = await readBoundedJson(response, 64 * 1024);
      stage = 'token_validation';
      if (!response.ok || !result || typeof result !== 'object' || Array.isArray(result)) throw new StoreError('STORE_UNAVAILABLE');
      const data = result as Record<string, unknown>;
      if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 16_384 || /\s/u.test(data.access_token)
        || data.token_type !== 'Bearer' || typeof data.expires_in !== 'number' || !Number.isInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > 3600) {
        throw new StoreError('STORE_UNAVAILABLE');
      }
      cached = { token: data.access_token, expiresAt: issuedAt + data.expires_in };
      return cached.token;
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', code: 'GOOGLE_OAUTH_FAILED', stage, status, exceptionName: safeStoreExceptionName(error) }));
      throw new StoreError('STORE_UNAVAILABLE');
    }
    finally { clearTimeout(timer); }
  }

  return async () => {
    if (cached && cached.expiresAt - nowSeconds() > 60) return cached.token;
    if (pending) return pending;
    pending = issue();
    try { return await pending; } finally { pending = null; }
  };
}
