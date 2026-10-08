import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vitest/config';

// Spotify only accepts loopback redirect URIs on 127.0.0.1 (not "localhost"),
// so the dev server binds there on a fixed port that matches the registered
// redirect URI http://127.0.0.1:8888/callback.
export default defineConfig({
  plugins: [cloudflare()],
  server: {
    host: '127.0.0.1',
    port: 8888,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 8888,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
