import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

async function copyIfExists(name) {
  const source = resolve(root, name);
  if (!existsSync(source)) return;
  await cp(source, resolve(dist, name), { recursive: true });
}

await mkdir(dist, { recursive: true });
await Promise.all([
  copyIfExists('content'),
  copyIfExists('icon'),
  copyIfExists('worker'),
  copyIfExists('version'),
  copyIfExists('LICENSE'),
  copyIfExists('README.md'),
]);
