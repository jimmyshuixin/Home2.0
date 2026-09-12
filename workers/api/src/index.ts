/// <reference path="../worker-configuration.d.ts" />
import { z } from 'zod';
import { createApi } from './app';
import { createAuthProvider } from './auth';
import { FirestoreStore } from './store/firestore';
import { UnconfiguredStore } from './store/unconfigured';
import { createGoogleAccessTokenProvider, GOOGLE_OAUTH_SCOPES, validServiceAccountConfig } from './store/google-oauth';
import { StoreError, type Store } from './store/types';
import { dispatchGitHubBuild, dispatchGitHubMedia, verifyGitHubRunner } from './github';
import { createMusicHandler } from './music';
const credentialSchema = z.object({ project_id: z.string(), client_email: z.string(), private_key: z.string() });
const authConfigSchema = z.object({ projectId: z.string(), apiKey: z.string(), adminUid: z.string(), adminUsername: z.string(), adminEmail: z.string(), passwordResetUrl: z.string() }).strict();
function parseSecret(value: string | undefined): unknown { try { return JSON.parse(value || '{}'); } catch { return null; } }
export default {
  async fetch(request, env) {
    const credential = credentialSchema.safeParse(parseSecret(env.GOOGLE_SERVICE_ACCOUNT)), authConfig = authConfigSchema.safeParse(parseSecret(env.FIREBASE_AUTH_CONFIG));
    const serviceAccount = credential.success ? { projectId: credential.data.project_id, clientEmail: credential.data.client_email, privateKey: credential.data.private_key } : undefined;
    const validCredential = serviceAccount && validServiceAccountConfig(serviceAccount);
    const getGoogleAccessToken = validCredential ? createGoogleAccessTokenProvider(serviceAccount, { scopes: [GOOGLE_OAUTH_SCOPES.datastore, GOOGLE_OAUTH_SCOPES.identityToolkit] }) : async () => { throw new StoreError('STORE_NOT_CONFIGURED'); };
    let store: Store = new UnconfiguredStore();
    if (validCredential && String(env.FIRESTORE_EDITION) === 'standard') {
      try { store = new FirestoreStore({ projectId: env.FIREBASE_PROJECT_ID, databaseId: env.FIRESTORE_DATABASE_ID, edition: 'standard', collectionPrefix: 'v3_test_' }, { getAccessToken: getGoogleAccessToken, maxAttempts: 1 }); }
      catch { /* Private APIs fail closed; a Firebase misconfiguration must not stop published R2 reads. */ }
    }
    const runtime = createApi({ store, bucket: env.CONTENT, auth: createAuthProvider(authConfig.success ? authConfig.data : undefined, { getGoogleAccessToken }), now: Date.now, secureCookies: true, allowedOrigins: [env.PUBLIC_ORIGIN], privacySalt: env.PRIVACY_SALT || '', adminUsername: authConfig.success ? authConfig.data.adminUsername : '', codeSha: env.BUILD_CODE_SHA,
      verifyRunner: request => verifyGitHubRunner(request, { repository: env.BUILD_REPOSITORY, ref: env.BUILD_REF, audience: `${env.PUBLIC_ORIGIN}/v3-runner` }),
      music: (request, snapshot, requestId) => createMusicHandler(env.MUSIC_ORIGIN)(request, snapshot, requestId),
      ...(env.GITHUB_TOKEN ? { dispatchBuild: job => dispatchGitHubBuild(job, { token: env.GITHUB_TOKEN, repository: env.BUILD_REPOSITORY, ref: env.BUILD_REF, origin: env.PUBLIC_ORIGIN }), dispatchMedia: assetId => dispatchGitHubMedia(assetId, { token: env.GITHUB_TOKEN, repository: env.BUILD_REPOSITORY, ref: env.BUILD_REF, origin: env.PUBLIC_ORIGIN }) } : {}),
    });
    return runtime.app.fetch(request);
  },
} satisfies ExportedHandler<ApiEnv>;
