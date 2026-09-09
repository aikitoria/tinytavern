import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    solid(),
    {
      name: 'watch-shared-source',
      configureServer(server) {
        // Watch the directory from startup, including new files and atomic replacements
        // outside Vite's client root, before imports populate its module graph.
        server.watcher.add(fileURLToPath(new URL('../shared/src', import.meta.url)));
      },
    },
  ],
  build: { target: 'es2022' },
  // Source is mounted read-only; transformed modules belong to the container.
  cacheDir: '/tmp/tinytavern-vite',
  // Caddy owns the public listener, TLS, source-IP gate and API/WebSocket routing.
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
  },
});
