import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  body: unknown;
  raw: Buffer | null;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  regex: RegExp;
  paramNames: string[];
  handler: Handler;
  rawBody: boolean;
  maxBodyBytes: number;
}

const routes: Route[] = [];

function add(
  method: string,
  pattern: string,
  handler: Handler,
  opts?: { rawBody?: boolean; maxBodyBytes?: number },
): void {
  const paramNames: string[] = [];
  const regexSrc = pattern.replace(/:([a-zA-Z]+)/g, (_, name: string) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  routes.push({
    method,
    regex: new RegExp(`^${regexSrc}$`),
    paramNames,
    handler,
    rawBody: opts?.rawBody ?? false,
    maxBodyBytes: opts?.maxBodyBytes ?? MAX_BODY,
  });
}

export const route = {
  get: (p: string, h: Handler) => add('GET', p, h),
  post: (p: string, h: Handler, opts?: { rawBody?: boolean; maxBodyBytes?: number }) =>
    add('POST', p, h, opts),
  put: (p: string, h: Handler, opts?: { rawBody?: boolean; maxBodyBytes?: number }) =>
    add('PUT', p, h, opts),
  patch: (p: string, h: Handler) => add('PATCH', p, h),
  del: (p: string, h: Handler) => add('DELETE', p, h),
};

const MAX_BODY = 32 * 1024 * 1024;

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Drain without destroying the socket so the 413 response can reach the client.
        req.removeAllListeners('data');
        req.resume();
        reject(new HttpError(413, 'body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Returns false if no route matched (caller falls through to static file serving). */
export async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    try {
      r.paramNames.forEach((name, i) => {
        try {
          params[name] = decodeURIComponent(m[i + 1]!);
        } catch {
          throw new HttpError(400, 'malformed percent-encoding in path');
        }
      });
      let body: unknown = null;
      let raw: Buffer | null = null;
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        const buf = await readBody(req, r.maxBodyBytes);
        if (r.rawBody) raw = buf;
        else if (buf.length > 0) {
          try {
            body = JSON.parse(buf.toString('utf8'));
          } catch {
            throw new HttpError(400, 'invalid JSON body');
          }
        }
      }
      const result = await r.handler({ req, res, params, body, raw });
      if (res.writableEnded) return true;
      if (result === undefined) {
        res.writeHead(204).end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      }
    } catch (err) {
      if (res.writableEnded) return true;
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 500) console.error(`[api] ${req.method} ${pathname}:`, err);
      res
        .writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: message }));
    }
    return true;
  }
  return false;
}
