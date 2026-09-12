import { AuthError, type AuthProvider, type AuthProviderDependencies, type FirebasePasswordConfig } from './types';
import { FirebasePasswordProvider, validFirebasePasswordConfig } from './firebase-password-provider';

export * from './types';
export { FirebasePasswordProvider } from './firebase-password-provider';

class UnconfiguredAuthProvider implements AuthProvider {
  async signIn(): Promise<never> { throw new AuthError('AUTH_NOT_CONFIGURED'); }
  async assertSession(): Promise<never> { throw new AuthError('AUTH_NOT_CONFIGURED'); }
  async changePassword(): Promise<never> { throw new AuthError('AUTH_NOT_CONFIGURED'); }
  async requestPasswordReset(): Promise<never> { throw new AuthError('AUTH_NOT_CONFIGURED'); }
  async confirmPasswordReset(): Promise<never> { throw new AuthError('AUTH_NOT_CONFIGURED'); }
  async revokeAllSessions(): Promise<never> { throw new AuthError('AUTH_NOT_CONFIGURED'); }
}

/** Partial runtime configuration is valid input; missing credentials fail closed. */
export function createAuthProvider(
  config: Partial<FirebasePasswordConfig> | undefined,
  dependencies: AuthProviderDependencies,
): AuthProvider {
  if (!validFirebasePasswordConfig(config) || typeof dependencies?.getGoogleAccessToken !== 'function') return new UnconfiguredAuthProvider();
  return new FirebasePasswordProvider(config, dependencies);
}
