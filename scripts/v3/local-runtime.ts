// Node-only development runtime. Production continues to use the Worker entry.
import { serve } from '@hono/node-server';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createApi } from '../../workers/api/src/app';
import { createAuthProvider } from '../../workers/api/src/auth';
import { validFirebasePasswordConfig } from '../../workers/api/src/auth/firebase-password-provider';
import { createGoogleAccessTokenProvider, GOOGLE_OAUTH_SCOPES, validServiceAccountConfig } from '../../workers/api/src/store/google-oauth';
import { SqliteStore } from '../../workers/api/src/store/sqlite';
import { createMusicHandler } from '../../workers/api/src/music';

const serviceAccountSchema = z.object({ project_id: z.string(), client_email: z.string(), private_key: z.string() }).passthrough();
const authSchema = z.object({ projectId: z.string(), apiKey: z.string(), adminUid: z.string(), adminUsername: z.string(), adminEmail: z.string(), passwordResetUrl: z.string() }).strict();
const configSchema = z.object({ firebaseAuthConfig: authSchema.optional(), googleServiceAccount: serviceAccountSchema.optional() }).strict();
export type LocalConfig = z.infer<typeof configSchema>;

export async function readLocalConfig(filename: string): Promise<LocalConfig> {
  let raw: string;
  try { raw = await readFile(filename, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('LOCAL_CONFIG_UNREADABLE'); }
  try { return configSchema.parse(JSON.parse(raw)); }
  catch { throw new Error('LOCAL_CONFIG_INVALID'); }
}

async function privacySalt(directory: string): Promise<string> {
  const filename = resolve(directory, 'privacy-salt');
  try { await writeFile(filename, Buffer.from(randomBytes(32)).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('LOCAL_SALT_UNAVAILABLE'); }
  const value = (await readFile(filename, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error('LOCAL_SALT_INVALID');
  return value;
}

async function boundedStream(value: ReadableStream<Uint8Array>, maximum: number): Promise<Uint8Array> {
  const reader = value.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new Error('LOCAL_R2_STREAM_TOO_LARGE'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function createLocalRuntime(options: { directory: string; codeSha: string; config?: LocalConfig; origins?: string[] }) {
  const directory = resolve(options.directory), config = configSchema.parse(options.config ?? {});
  const origins = options.origins ?? ['http://127.0.0.1:8787', 'http://127.0.0.1:3000', 'http://127.0.0.1:5174'];
  if (!origins.length || origins.some(origin => !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(origin) || new URL(origin).origin !== origin)) throw new Error('LOCAL_ORIGIN_INVALID');
  if (!/^[a-f0-9]{40}$/u.test(options.codeSha)) throw new Error('LOCAL_CODE_SHA_INVALID');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const salt = await privacySalt(directory);
  const service = config.googleServiceAccount && { projectId: config.googleServiceAccount.project_id, clientEmail: config.googleServiceAccount.client_email, privateKey: config.googleServiceAccount.private_key };
  const authConfigured = Boolean(service && validServiceAccountConfig(service) && validFirebasePasswordConfig(config.firebaseAuthConfig) && service.projectId === config.firebaseAuthConfig!.projectId);
  // A partial setup cannot create a local session. Both auth and the Google
  // account lookup use the actual configured Firebase project when complete.
  const getGoogleAccessToken = authConfigured ? createGoogleAccessTokenProvider(service!, { scopes: [GOOGLE_OAUTH_SCOPES.identityToolkit] }) : async () => { throw new Error('AUTH_NOT_CONFIGURED'); };
  const mf = new Miniflare({ ...convertV4MiniflareOptions({
    modules: true, compatibilityDate: '2026-09-12', r2Buckets: ['CONTENT'],
    script: `export default { async fetch(request, env) {
      if (new URL(request.url).pathname === '/r2-put') {
        const result = await env.CONTENT.put(request.headers.get('x-local-key'), request.body, JSON.parse(request.headers.get('x-local-options')));
        return Response.json(result);
      }
      const { html, handlers } = await request.json();
      let rewriter = new HTMLRewriter();
      for (const handler of handlers) rewriter = rewriter.on(handler.selector, { element(element) { element.prepend(handler.prefix, {html:true}); } });
      return rewriter.transform(new Response(html));
    } }`,
  }), resourcePersistencePath: resolve(directory, 'r2'), telemetry: { enabled: false }, cf: false });
  let store: SqliteStore | undefined;
  const originalRewriter = Object.getOwnPropertyDescriptor(globalThis, 'HTMLRewriter');
  class LocalHTMLRewriter {
    handlers: { selector: string; prefix: string }[] = [];
    on(selector: string, handler: { element(element: { prepend(value: string, options?: { html: boolean }): void }): void }) {
      const next = { selector, prefix: '' };
      handler.element({ prepend(value) { next.prefix += value; } }); this.handlers.push(next); return this;
    }
    transform(response: Response) {
      const handlers = [...this.handlers];
      const stream = new ReadableStream<Uint8Array>({ async start(controller) {
        try {
          const bytes = await boundedStream(response.body!, 25 * 1024 * 1024);
          const rewritten = await mf.dispatchFetch('http://local-rewriter.invalid/transform', { method: 'POST', body: JSON.stringify({ html: new TextDecoder().decode(bytes), handlers }) });
          if (!rewritten.ok || !rewritten.body) throw new Error('LOCAL_REWRITER_FAILED');
          const reader = rewritten.body.getReader();
          try { for (;;) { const next = await reader.read(); if (next.done) break; controller.enqueue(next.value); } }
          finally { reader.releaseLock(); }
          controller.close();
        } catch (error) { controller.error(error); }
      } });
      return new Response(stream, { status: response.status, headers: response.headers });
    }
  }
  try {
    const actualBucket = await mf.getR2Bucket('CONTENT') as unknown as R2Bucket;
    const bucket = new Proxy(actualBucket, { get(target, property) {
      const member = Reflect.get(target, property);
      if (property === 'put') return async (...args: Parameters<R2Bucket['put']>) => {
        const [key, value, putOptions] = args;
        if (!(value instanceof ReadableStream)) return target.put(...args);
        // The JS proxy drops workerd's known-length marker. HTTP transport
        // restores it; actual R2 still enforces the original checksum/options.
        const bytes = await boundedStream(value, 25 * 1024 * 1024);
        const response = await mf.dispatchFetch('http://local-r2.invalid/r2-put', { method: 'PUT', body: bytes,
          headers: { 'content-length': String(bytes.byteLength), 'x-local-key': key, 'x-local-options': JSON.stringify(putOptions ?? {}) } });
        if (!response.ok) { await response.body?.cancel(); throw new Error('LOCAL_R2_PUT_FAILED'); }
        const result = await response.json() as (Record<string, unknown> & { uploaded: string }) | null;
        return result ? { ...result, uploaded: new Date(result.uploaded) } : null;
      };
      return typeof member === 'function' ? member.bind(target) : member;
    } });
    store = new SqliteStore(resolve(directory, 'dev-api.sqlite'));
    Object.defineProperty(globalThis, 'HTMLRewriter', { configurable: true, writable: true, value: LocalHTMLRewriter });
    const api = createApi({ store, bucket, auth: createAuthProvider(authConfigured ? config.firebaseAuthConfig : undefined, { getGoogleAccessToken }), now: Date.now,
      secureCookies: false, allowedOrigins: origins, privacySalt: salt, adminUsername: authConfigured ? config.firebaseAuthConfig!.adminUsername : '', codeSha: options.codeSha,
      music: createMusicHandler('https://music.xvyin.com') });
    let closed = false;
    return { api, store, bucket, authConfigured, async close() {
      if (closed) return; closed = true;
      try { await store!.close(); } finally {
        if (Reflect.get(globalThis, 'HTMLRewriter') === LocalHTMLRewriter) {
          if (originalRewriter) Object.defineProperty(globalThis, 'HTMLRewriter', originalRewriter); else Reflect.deleteProperty(globalThis, 'HTMLRewriter');
        }
        await mf.dispose();
      }
    } };
  } catch (error) { await store?.close(); await mf.dispose(); throw error; }
}

export async function startLocalServer(options: Parameters<typeof createLocalRuntime>[0] & { port?: number }) {
  const port = options.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('LOCAL_PORT_INVALID');
  const runtime = await createLocalRuntime(options);
  const server = serve({ fetch: runtime.api.app.fetch, hostname: '127.0.0.1', port });
  try { await new Promise<void>((resolveReady, reject) => { server.once('listening', resolveReady); server.once('error', reject); }); }
  catch (error) { await runtime.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') { await runtime.close(); throw new Error('LOCAL_SERVER_UNAVAILABLE'); }
  let closing: Promise<void> | undefined;
  return { ...runtime, origin: `http://127.0.0.1:${address.port}`, close() {
    return closing ??= (async () => {
      try { await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed())); }
      finally { await runtime.close(); }
    })();
  } };
}
