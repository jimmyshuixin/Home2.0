import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { readLocalConfig, startLocalServer } from '../local-runtime';

describe('real local API entry', () => {
  it('serves health, fails closed without credentials, and persists SQLite / R2 through shutdown', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'xvyin-local-entry-'));
    let server: Awaited<ReturnType<typeof startLocalServer>> | undefined;
    try {
      expect(await readLocalConfig(resolve(directory, 'missing.json'))).toEqual({});
      server = await startLocalServer({ directory, codeSha: 'a'.repeat(40), port: 0 });
      expect(server.authConfigured).toBe(false);
      const health = await fetch(`${server.origin}/api/v1/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ data: { status: 'ok', schemaVersion: 1 } });
      const login = await fetch(`${server.origin}/api/v1/auth/login`, { method: 'POST', headers: { origin: 'http://127.0.0.1:5174', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'not-an-account', password: 'not-a-password' }) });
      expect(login.status).toBe(503); expect(login.headers.get('set-cookie')).toBeNull();
      expect(await login.json()).toMatchObject({ error: { code: 'AUTH_NOT_CONFIGURED' } });
      const admin = await fetch(`${server.origin}/api/v1/admin/creations`);
      expect(admin.status).toBe(401); await admin.body?.cancel();
      expect((await server.store.list('creations')).items).toEqual([]);
      const rejected = await fetch(`${server.origin}/api/v1/auth/login`, { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: '{}' });
      expect(rejected.status).toBe(403); await rejected.body?.cancel();
      // Direct storage fixtures exercise the runtime, never fabricate an admin.
      await server.store.transaction(async tx => { tx.put('local_checks/persistence', { value: 'local test fixture' }); });
      await server.bucket.put('local-checks/file.txt', new Blob(['persistent local R2']).stream());
      const salt = await readFile(resolve(directory, 'privacy-salt'), 'utf8');
      await server.close(); await server.close(); server = undefined;
      server = await startLocalServer({ directory, codeSha: 'a'.repeat(40), port: 0 });
      expect(await server.store.get('local_checks/persistence')).toEqual({ value: 'local test fixture' });
      expect(await (await server.bucket.get('local-checks/file.txt'))?.text()).toBe('persistent local R2');
      expect(await readFile(resolve(directory, 'privacy-salt'), 'utf8')).toBe(salt);
      expect(server.authConfigured).toBe(false);
      await writeFile(resolve(directory, 'broken.json'), '{private malformed value');
      await expect(readLocalConfig(resolve(directory, 'broken.json'))).rejects.toThrow('LOCAL_CONFIG_INVALID');
    } finally {
      await server?.close();
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('xvyin-local-entry-')) throw new Error('Unexpected test cleanup directory');
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
