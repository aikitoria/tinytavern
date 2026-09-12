import type { BunRequest, Serve, Server } from 'bun';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Ctx {
  req: Request;
  headers: Headers;
  remoteAddress: string | undefined;
  params: Record<string, string>;
  body: unknown;
  raw: Buffer | null;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
interface Route {
  handler: Handler;
  rawBody: boolean;
  maxBodyBytes: number;
}

const MAX_BODY = 32 * 1024 * 1024;
const routes = new Map<string, Map<string, Route>>();
const API_HEADERS = { 'cache-control': 'private, no-store' };

function add(
  method: string,
  path: string,
  handler: Handler,
  opts?: { rawBody?: boolean; maxBodyBytes?: number },
): void {
  let methods = routes.get(path);
  if (!methods) routes.set(path, (methods = new Map()));
  if (methods.has(method)) throw new Error(`Duplicate route: ${method} ${path}`);
  methods.set(method, {
    handler,
    rawBody: opts?.rawBody ?? false,
    maxBodyBytes: opts?.maxBodyBytes ?? MAX_BODY,
  });
}

export const route = {
  get: (p: string, h: Handler) => add('GET', p, h),
  post: (p: string, h: Handler, opts?: { rawBody?: boolean; maxBodyBytes?: number }) => add('POST', p, h, opts),
  put: (p: string, h: Handler, opts?: { rawBody?: boolean; maxBodyBytes?: number }) => add('PUT', p, h, opts),
  patch: (p: string, h: Handler) => add('PATCH', p, h),
  del: (p: string, h: Handler) => add('DELETE', p, h),
};

export function apiError(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: API_HEADERS });
}

async function readBody(req: Request, maxBytes: number): Promise<Buffer> {
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) throw new HttpError(413, 'body too large');
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, 'body too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function invoke(req: BunRequest, matched: Route, remoteAddress: string | undefined): Promise<Response> {
  try {
    // Bun decodes route params. Validate malformed percent escapes without decoding twice.
    if (req.url.includes('%')) {
      try {
        decodeURI(new URL(req.url).pathname);
      } catch {
        throw new HttpError(400, 'malformed percent-encoding in path');
      }
    }
    let body: unknown = null;
    let raw: Buffer | null = null;
    if (req.method !== 'GET') {
      const bytes = await readBody(req, matched.maxBodyBytes);
      if (matched.rawBody) raw = bytes;
      else if (bytes.length) {
        try {
          body = JSON.parse(bytes.toString('utf8'));
        } catch {
          throw new HttpError(400, 'invalid JSON body');
        }
      }
    }
    const headers = new Headers(API_HEADERS);
    // Body reading finishes before the synchronous handler's guard-and-act section.
    const result = await matched.handler({
      req,
      headers,
      remoteAddress,
      params: req.params,
      body,
      raw,
    });
    if (result instanceof Response) {
      for (const [key, value] of headers) result.headers.set(key, value);
      return result;
    }
    return result === undefined ? new Response(null, { status: 204, headers }) : Response.json(result, { headers });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 500) console.error(`[api] ${req.method} ${new URL(req.url).pathname}:`, err);
    return apiError(status, message);
  }
}

/** Bun compiles the paths once. Method lookup is constant-time and every route uses the same gate. */
export function apiRoutes<T>(
  authorize?: (req: Request, server: Server<T>) => Response | undefined,
): Serve.Routes<T, string> {
  return Object.fromEntries(
    [...routes].map(([path, methods]) => [
      path,
      (req: BunRequest, server: Server<T>) => {
        const rejected = authorize?.(req, server);
        if (rejected) return rejected;
        const matched = methods.get(req.method);
        return matched ? invoke(req, matched, server.requestIP(req)?.address) : apiError(404, 'not found');
      },
    ]),
  );
}
