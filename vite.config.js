import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(rootDir, 'index.html'),
        contact: resolve(rootDir, 'contact.html'),
        deepseek: resolve(rootDir, 'deepseek.html'),
      },
    },
  },
});
