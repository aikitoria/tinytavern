import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  build: { target: 'es2022' },
  // Caddy owns the public listener, TLS, source-IP gate and API/WebSocket routing.
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
  },
});
