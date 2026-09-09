import assert from 'node:assert/strict';
import { requireTestIsolation } from './isolation.ts';

/** Only serves route modules explicitly imported by the caller. */
export async function testApi() {
  requireTestIsolation();
  const { apiRoutes } = await import('../../server/src/http/router.ts');
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    routes: apiRoutes(),
    fetch: () => new Response(null, { status: 404 }),
    idleTimeout: 0,
  });
  const base = `http://127.0.0.1:${server.port}`;
  async function request(method: string, path: string, body?: unknown, status?: number) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const message = `${method} ${path}: ${response.status} ${text}`;
    if (status === undefined) assert(response.ok, message);
    else assert.equal(response.status, status, message);
    return text ? JSON.parse(text) : undefined;
  }
  return { server, base, request };
}
