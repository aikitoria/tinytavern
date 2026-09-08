import { caddyEnabled } from './mediaUrls.ts';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AVATAR_DIR, IMAGES_DIR, db } from './db.ts';
import { stopAllGenerations } from './generation.ts';
import { dispatch } from './router.ts';
import { initWebSocket, setSubscribeHandler, setUnsubscribeHandler } from './events.ts';
import { sendTreeTo } from './sync.ts';
import { cancelBackgroundSwipe, prepareActiveSwipe } from './speculation.ts';
import {
  configuredIpAllowlist,
  isRequestIpAllowed,
  isRequestOriginAllowed,
  requestIp,
} from './ipAccess.ts';
import { isRequestAuthenticated } from './auth.ts';
import { sweepOrphanedImages } from './images.ts';
import { initMediaWorker, stopMediaWorker } from './mediaWorker.ts';
import { initMediaThumbnails, stopMediaThumbnails } from './mediaThumbnails.ts';
import './routes/conversations.ts';
import './routes/messages.ts';
import './routes/gallery.ts';
import './routes/mediaJobs.ts';
import './routes/presets.ts';
import './routes/templates.ts';
import './routes/personas.ts';
import './routes/characters.ts';
import './routes/characterFolders.ts';
import './routes/avatarGenerate.ts';
import './routes/endpoints.ts';
import './routes/settings.ts';
import './routes/conversationTransfer.ts';
import './routes/draftCompletion.ts';
import './routes/auth.ts';

const PORT = Number(process.env.PORT ?? 5487);

// Backstop for image-file deletion guarantees (crash windows, late renders).
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

/** Isolated HTTP regressions serve media here; deployed stacks serve it through Caddy. */
async function serveFile(
  res: ServerResponse,
  path: string,
  extraHeaders: Record<string, string> = {},
  range?: string,
): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    let start = 0;
    let end = info.size - 1;
    let partial = false;
    const requestedRange = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (requestedRange && (requestedRange[1] || requestedRange[2])) {
      if (requestedRange[1]) {
        start = Number(requestedRange[1]);
        if (requestedRange[2]) {
          end = Math.min(end, Number(requestedRange[2]));
        }
      } else {
        start = Math.max(0, info.size - Number(requestedRange[2]));
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= info.size
      ) {
        res.writeHead(416, { 'content-range': `bytes */${info.size}`, ...extraHeaders }).end();
        return true;
      }
      partial = true;
    }
    res.writeHead(partial ? 206 : 200, {
      'content-type': MIME[extname(path)] ?? 'application/octet-stream',
      'content-length': Math.max(0, end - start + 1),
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      ...(partial ? { 'content-range': `bytes ${start}-${end}/${info.size}` } : {}),
      ...extraHeaders,
    });
    if (info.size === 0) {
      res.end();
      return true;
    }
    const stream = createReadStream(path, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return true;
  } catch {
    return false;
  }
}

function safeJoin(root: string, urlPath: string): string | null {
  const base = resolve(root);
  const path = resolve(base, urlPath.replace(/^\/+/, ''));
  const rel = relative(base, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? path : null;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isRequestIpAllowed(req)) {
    res
      .writeHead(403, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: 'IP address is not allowed' }));
    console.warn(`[access] rejected ${requestIp(req) ?? 'unknown address'}`);
    return;
  }
  const url = new URL(req.url ?? '/', 'http://x');
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    // Prevent private API data surviving logout/password changes in caches.
    res.setHeader('cache-control', 'private, no-store');
    if (!isRequestOriginAllowed(req)) {
      res
        .writeHead(403, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'cross-site requests are not allowed' }));
      return;
    }
    // Pre-login endpoints still require IP and same-origin checks.
    const publicAuthEndpoint =
      pathname === '/api/auth/status' ||
      pathname === '/api/auth/login' ||
      pathname === '/api/auth/logout';
    if (!publicAuthEndpoint && !isRequestAuthenticated(req)) {
      res
        .writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'authentication required' }));
      return;
    }
    if (await dispatch(req, res, pathname)) return;
    res
      .writeHead(404, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: 'not found' }));
    return;
  }

  if (caddyEnabled) {
    res.writeHead(404).end('not found');
    return;
  }

  if (pathname.startsWith('/avatars/')) {
    if (!isRequestAuthenticated(req)) {
      res.writeHead(401).end();
      return;
    }
    const path = safeJoin(AVATAR_DIR, pathname.slice('/avatars/'.length));
    if (path && (await serveFile(res, path))) return;
    res.writeHead(404).end();
    return;
  }

  if (pathname.startsWith('/images/')) {
    if (!isRequestAuthenticated(req)) {
      res.writeHead(401).end();
      return;
    }
    const imageExt = extname(pathname).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.webm'].includes(imageExt)) {
      res.writeHead(404).end();
      return;
    }
    // Media is user data: force every load through the session check above.
    const path = safeJoin(IMAGES_DIR, pathname.slice('/images/'.length));
    if (
      path &&
      (await serveFile(
        res,
        path,
        {
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'no-store',
        },
        req.headers.range,
      ))
    )
      return;
    res.writeHead(404).end();
    return;
  }

  res.writeHead(404).end('not found');
}

function onRequest(req: IncomingMessage, res: ServerResponse): void {
  handleRequest(req, res).catch((err) => {
    console.error('[http] unhandled error:', err);
    if (!res.writableEnded) res.writeHead(500).end();
  });
}

const server = http.createServer(onRequest);

setUnsubscribeHandler((conversationId) => {
  try {
    cancelBackgroundSwipe(conversationId);
  } catch (err) {
    console.error(`[ws] unsubscribe handler failed for conversation ${conversationId}:`, err);
  }
});
setSubscribeHandler((ws, conversationId) => {
  // The ws listener has no upstream catch; an escaping throw crashes the process.
  try {
    sendTreeTo(ws, conversationId);
    prepareActiveSwipe(conversationId);
  } catch (err) {
    console.error(`[ws] subscribe handler failed for conversation ${conversationId}:`, err);
  }
});
initWebSocket(server);

server.listen(PORT, () => {
  console.log(`tinytavern server listening on http://0.0.0.0:${PORT}`);
  console.log(`IP allowlist: ${configuredIpAllowlist()}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    try {
      stopMediaWorker();
      stopAllGenerations();
      await stopMediaThumbnails();
      db.close();
      process.exit(0);
    } catch (err) {
      console.error('[shutdown] could not save active generations:', err);
      process.exit(1);
    }
  });
}
