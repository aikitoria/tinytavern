import type { Server } from 'bun';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { stat } from 'node:fs/promises';
import { caddyEnabled } from './media/mediaUrls.ts';
import { AVATAR_DIR, IMAGES_DIR, db } from './db/db.ts';
import { stopAllGenerations } from './generation/generation.ts';
import { apiRoutes, apiError } from './http/router.ts';
import {
  websocket,
  bindWebSocketServer,
  sendTo,
  setSubscribeHandler,
  setUnsubscribeHandler,
  type SocketState,
} from './realtime/events.ts';
import { sendTreeTo } from './realtime/sync.ts';
import { cancelBackgroundSwipe, prepareActiveSwipe } from './generation/speculation.ts';
import {
  configuredIpAllowlist,
  isRequestIpAllowed,
  isRequestOriginAllowed,
  requestIp,
} from './http/ipAccess.ts';
import { isRequestAuthenticated } from './http/auth.ts';
import { sweepOrphanedImages } from './media/images.ts';
import { initMediaWorker, stopMediaWorker } from './media/mediaWorker.ts';
import { activeMediaJobs } from './media/mediaJobStore.ts';
import { initMediaThumbnails, stopMediaThumbnails } from './media/mediaThumbnails.ts';
import './routes/conversations.ts';
import './routes/messages.ts';
import './routes/gallery.ts';
import './routes/mediaJobs.ts';
import './routes/presets.ts';
import './routes/templates.ts';
import './routes/personas.ts';
import './routes/characters.ts';
import './routes/characterFolders.ts';
import './routes/endpoints.ts';
import './routes/settings.ts';
import './routes/conversationTransfer.ts';
import './routes/draftCompletion.ts';
import './routes/auth.ts';

initMediaWorker();
sweepOrphanedImages();
initMediaThumbnails();

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
};

function safeJoin(root: string, urlPath: string): string | null {
  const base = resolve(root);
  const path = resolve(base, urlPath.replace(/^\/+/, ''));
  const rel = relative(base, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? path : null;
}

/** Deployed media is served by Caddy; isolated HTTP tests use the same authenticated paths here. */
async function mediaResponse(req: Request, path: string, image: boolean): Promise<Response> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return new Response(null, { status: 404 });
    const headers = new Headers({
      'content-type': MIME[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'private, no-store',
      'accept-ranges': 'bytes',
    });
    if (image) {
      headers.set('x-content-type-options', 'nosniff');
      headers.set('content-security-policy', "default-src 'none'; sandbox");
    }
    let start = 0;
    let end = info.size - 1;
    let partial = false;
    const range = req.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/);
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      } else start = Math.max(0, info.size - Number(range[2]));
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= info.size
      ) {
        headers.set('content-range', `bytes */${info.size}`);
        return new Response(null, { status: 416, headers });
      }
      partial = true;
      headers.set('content-range', `bytes ${start}-${end}/${info.size}`);
    }
    headers.set('content-length', String(Math.max(0, end - start + 1)));
    const file = Bun.file(path);
    return new Response(info.size === 0 ? null : partial ? file.slice(start, end + 1) : file, {
      status: partial ? 206 : 200,
      headers,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('[media] file read failed:', err);
    return new Response(null, { status: 404 });
  }
}

function authorize(req: Request, server: Server<SocketState>): Response | undefined {
  const remoteAddress = server.requestIP(req)?.address;
  if (!isRequestIpAllowed(req, remoteAddress)) {
    console.warn(`[access] rejected ${requestIp(req, remoteAddress) ?? 'unknown address'}`);
    return apiError(403, 'IP address is not allowed');
  }
  if (!isRequestOriginAllowed(req)) return apiError(403, 'cross-site requests are not allowed');
  const pathname = new URL(req.url).pathname;
  const publicAuth = ['/api/auth/status', '/api/auth/login', '/api/auth/logout'].includes(pathname);
  if (!publicAuth && !isRequestAuthenticated(req)) return apiError(401, 'authentication required');
  // Generation/Comfy deadlines own long requests; Bun's short HTTP idle timer must not end them.
  server.timeout(req, 0);
}

setUnsubscribeHandler((id) => {
  try {
    cancelBackgroundSwipe(id);
  } catch (err) {
    console.error(`[ws] unsubscribe handler failed for conversation ${id}:`, err);
  }
});
setSubscribeHandler((ws, id) => {
  try {
    sendTreeTo(ws, id);
    prepareActiveSwipe(id);
  } catch (err) {
    console.error(`[ws] subscribe handler failed for conversation ${id}:`, err);
  }
});

const server = Bun.serve({
  port: Number(process.env.PORT ?? 5487),
  hostname: '0.0.0.0',
  idleTimeout: 30,
  // Per-route limits are checked while reading. The router owns consistent JSON 413 responses.
  maxRequestBodySize: 512 * 1024 * 1024,
  routes: apiRoutes<SocketState>(authorize),
  websocket,
  fetch(req, server) {
    const pathname = new URL(req.url).pathname;
    if (pathname.startsWith('/api/') || pathname === '/ws') {
      const rejected = authorize(req, server);
      if (rejected) return rejected;
      if (pathname === '/ws') {
        return server.upgrade(req, { data: { sub: null, closed: false } })
          ? undefined
          : apiError(400, 'WebSocket upgrade required');
      }
      return apiError(404, 'not found');
    }
    if (!isRequestIpAllowed(req, server.requestIP(req)?.address))
      return apiError(403, 'IP address is not allowed');
    if (caddyEnabled) return new Response(null, { status: 404 });
    const image = pathname.startsWith('/images/');
    const avatar = pathname.startsWith('/avatars/');
    if (image || avatar) {
      if (!isRequestAuthenticated(req)) return new Response(null, { status: 401 });
      if (image && !MIME[extname(pathname).toLowerCase()])
        return new Response(null, { status: 404 });
      const path = safeJoin(image ? IMAGES_DIR : AVATAR_DIR, pathname.slice(image ? 8 : 9));
      if (path) return mediaResponse(req, path, image);
    }
    return new Response(null, { status: 404 });
  },
  error(err) {
    console.error('[http] unhandled error:', err);
    return apiError(500, 'internal server error');
  },
});
// Seed job identities before this socket can receive progress, including on reconnect.
bindWebSocketServer(server, (ws) => sendTo(ws, { t: 'mediaJobs', jobs: activeMediaJobs() }));
console.log(`tinytavern server listening on http://0.0.0.0:${server.port}`);
console.log(`IP allowlist: ${configuredIpAllowlist()}`);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      stopMediaWorker();
      stopAllGenerations();
      await server.stop(true);
      await stopMediaThumbnails();
      db.close(true);
      process.exit(0);
    } catch (err) {
      console.error('[shutdown] could not save active generations:', err);
      process.exit(1);
    }
  });
}
