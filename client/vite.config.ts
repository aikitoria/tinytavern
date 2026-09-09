import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

export default defineConfig({
  plugins: [
    tailwindcss(),
    solid(),
    {
      name: 'precompress-static-assets',
      apply: 'build',
      enforce: 'post',
      generateBundle: {
        order: 'post',
        handler(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (!/\.(?:js|css)$/.test(output.fileName)) continue;
            const source = output.type === 'chunk' ? output.code : output.source;
            const data = typeof source === 'string' ? Buffer.from(source) : source;
            const compressed = {
              br: brotliCompressSync(data, {
                params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
              }),
              zst: Bun.zstdCompressSync(data, { level: 19 }),
              gz: gzipSync(data, { level: 9 }),
            };
            for (const [extension, source] of Object.entries(compressed))
              this.emitFile({ type: 'asset', fileName: `${output.fileName}.${extension}`, source });
          }
        },
      },
    },
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
