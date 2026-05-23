import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Standalone vite config used for browser-only UI previews (StatusBar etc).
// Mirrors the `renderer` block of electron.vite.config.ts but skips the
// Electron preload bridge — the daemon-client falls back to offline mode
// when window.stardew is absent.
export default defineConfig({
  root: 'src/renderer',
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer'),
    },
  },
  plugins: [react()],
  server: { port: 5174, strictPort: true },
});
