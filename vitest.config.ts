import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/**/test/**/*.test.ts', 'workers/**/test/**/*.test.ts', 'apps/**/tests/**/*.test.ts', 'scripts/**/test/**/*.test.ts'], testTimeout: 15000, fileParallelism: true } });
