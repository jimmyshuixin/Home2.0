import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readLocalConfig, startLocalServer } from './v3/local-runtime';

const root = resolve(import.meta.dirname, '..');
try {
  const codeSha = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim();
  const config = await readLocalConfig(resolve(root, '.local-data/dev-api.config.json'));
  const runtime = await startLocalServer({ directory: resolve(root, '.local-data'), codeSha, config });
  console.log(`V3 API: ${runtime.origin} · SQLite + local workerd R2`);
  console.log(runtime.authConfigured ? 'Administrator authentication: actual configured Firebase account.' : 'Administrator authentication: disabled until private Firebase configuration is complete.');
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; try { await runtime.close(); } catch { process.exitCode = 1; } };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) {
  const code = error instanceof Error && /^LOCAL_[A-Z_]+$/u.test(error.message) ? error.message : 'LOCAL_START_FAILED';
  console.error(`${code}: see scripts/v3/README.md; no credentials are logged.`); process.exitCode = 1;
}
