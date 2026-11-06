import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = resolve(__dirname);

/**
 * Renderer build. Output goes to apps/desktop/dist/renderer, which main.ts
 * resolves relative to its own compiled location (dist/electron).
 */
export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@studdy/shared': resolve(root, '../../packages/shared/src/index.ts'),
      '@studdy/mascot': resolve(root, '../../packages/mascot/src/index.ts'),
      '@studdy/chat-ui': resolve(root, '../../packages/chat-ui/src/index.ts'),
      '@studdy/screen-overlay': resolve(root, '../../packages/screen-overlay/src/index.ts'),
    },
  },
  build: {
    outDir: resolve(root, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
    rollupOptions: {
      input: resolve(root, 'index.html'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5180,
    strictPort: false,
  },
});
