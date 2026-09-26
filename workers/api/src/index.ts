/// <reference path="../worker-configuration.d.ts" />
import { z } from 'zod';
import { createApi } from './app';
import { createAuthProvider } from './auth';
import { FirestoreStore } from './store/firestore';
import { UnconfiguredStore } from './store/unconfigured';
import { createGoogleAccessTokenProvider, GoogleAccessTokenCache, GOOGLE_OAUTH_SCOPES, validServiceAccountConfig } from './store/google-oauth';
import { StoreError, type Store } from './store/types';
import { dispatchGitHubBuild, dispatchGitHubMedia, dispatchGitHubSocial, verifyGitHubRunner } from './github';
import { createMusicHandler } from './music';
import type { PublicReadCache } from './public-read-cache';
import { Engagement } from './engagement';
import { verifySocialSyncRunner } from './social-sync-auth';
const credentialSchema = z.object({ project_id: z.string(), client_email: z.string(), private_key: z.string() });
const authConfigSchema = z.object({ projectId: z.string(), apiKey: z.string(), adminUid: z.string(), adminUsername: z.string(), adminEmail: z.string(), passwordResetUrl: z.string() }).strict();
function parseSecret(value: string | undefined): unknown { try { return JSON.parse(value || '{}'); } catch { return null; } }
const completedGoogleTokens = new GoogleAccessTokenCache();
export default {
  async scheduled(event, env, ctx) {
    if (event.cron === '17 * * * *') {
      ctx.waitUntil(dispatchGitHubSocial(env.GITHUB_TOKEN).then(() => {
        console.info(JSON.stringify({ event: 'social_sync_dispatched', scheduledAt: new Date(event.scheduledTime).toISOString() }));
      }));
      return;
    }
    if (event.cron !== '0 16 * * *') return;
    // A daily free Workers Cron performs real deletion; Firestore paid TTL is not used.
    const credential = credentialSchema.parse(parseSecret(env.GOOGLE_SERVICE_ACCOUNT));
    const serviceAccount = { projectId: credential.project_id, clientEmail: credential.client_email, privateKey: credential.private_key };
    const getAccessToken = createGoogleAccessTokenProvider(serviceAccount, { scopes: [GOOGLE_OAUTH_SCOPES.datastore], completedTokenCache: completedGoogleTokens });
    const store = new FirestoreStore({ projectId: env.FIREBASE_PROJECT_ID, databaseId: env.FIRESTORE_DATABASE_ID, edition: 'standard', collectionPrefix: 'v3_test_' }, { getAccessToken, maxAttempts: 2 });
    ctx.waitUntil(new Engagement(store, env.PRIVACY_SALT, Date.now).cleanup());
  },
  async fetch(request, env, ctx) {
    const publicReadCache: PublicReadCache = { cache: await caches.open('xvyin-public-v1'), origin: env.PUBLIC_ORIGIN, waitUntil: promise => ctx.waitUntil(promise) };
    const credential = credentialSchema.safeParse(parseSecret(env.GOOGLE_SERVICE_ACCOUNT)), authConfig = authConfigSchema.safeParse(parseSecret(env.FIREBASE_AUTH_CONFIG));
    const serviceAccount = credential.success ? { projectId: credential.data.project_id, clientEmail: credential.data.client_email, privateKey: credential.data.private_key } : undefined;
    const validCredential = serviceAccount && validServiceAccountConfig(serviceAccount);
    const getGoogleAccessToken = validCredential ? createGoogleAccessTokenProvider(serviceAccount, { scopes: [GOOGLE_OAUTH_SCOPES.datastore, GOOGLE_OAUTH_SCOPES.identityToolkit], completedTokenCache: completedGoogleTokens }) : async () => { throw new StoreError('STORE_NOT_CONFIGURED'); };
    let store: Store = new UnconfiguredStore();
    if (validCredential && String(env.FIRESTORE_EDITION) === 'standard') {
      try { store = new FirestoreStore({ projectId: env.FIREBASE_PROJECT_ID, databaseId: env.FIRESTORE_DATABASE_ID, edition: 'standard', collectionPrefix: 'v3_test_' }, { getAccessToken: getGoogleAccessToken, maxAttempts: 2 }); }
      catch { /* Private APIs fail closed; a Firebase misconfiguration must not stop published R2 reads. */ }
    }
    const githubToken = env.GITHUB_TOKEN;
    const runtime = createApi({ store, bucket: env.CONTENT, auth: createAuthProvider(authConfig.success ? authConfig.data : undefined, { getGoogleAccessToken }), now: Date.now, secureCookies: true, allowedOrigins: [env.PUBLIC_ORIGIN], privacySalt: env.PRIVACY_SALT || '', adminUsername: authConfig.success ? authConfig.data.adminUsername : '', codeSha: env.BUILD_CODE_SHA,
      publicReadCache,
      waitUntil: promise => ctx.waitUntil(promise),
      verifyRunner: request => verifyGitHubRunner(request, { repository: env.BUILD_REPOSITORY, ref: env.BUILD_REF, audience: `${env.PUBLIC_ORIGIN}/v3-runner` }),
      verifySocialRunner: request => verifySocialSyncRunner(request),
      music: (request, snapshot, requestId, privateView) => createMusicHandler(env.MUSIC_ORIGIN, globalThis.fetch.bind(globalThis), env.PUBLIC_ORIGIN, privateView ? undefined : publicReadCache)(request, snapshot, requestId),
      ...(githubToken ? { dispatchBuild: job => dispatchGitHubBuild(job, { token: githubToken, repository: env.BUILD_REPOSITORY, ref: env.BUILD_REF, origin: env.PUBLIC_ORIGIN }), dispatchMedia: assetId => dispatchGitHubMedia(assetId, { token: githubToken, repository: env.BUILD_REPOSITORY, ref: env.BUILD_REF, origin: env.PUBLIC_ORIGIN }) } : {}),
    });
    return runtime.app.fetch(request);
  },
} satisfies ExportedHandler<ApiEnv & { GITHUB_TOKEN?: string }>;
