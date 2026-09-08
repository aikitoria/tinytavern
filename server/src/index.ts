import { caddyEnabled } from './mediaUrls.ts';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createReadStream, existsSync, readFileSync, watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AVATAR_DIR, IMAGES_DIR, db } from './db.ts';
import { stopAllGenerations } from './generation.ts';
import { dispatch } from './router.ts';
import {
  initWebSocket,
  setSubscribeHandler,
  setUnsubscribeHandler,
  subscribedConversationIds,
} from './events.ts';
import { sendTreeTo } from './sync.ts';
import { cancelBackgroundSwipe, prepareActiveSwipe } from './routes/conversations.ts';
import {
  configuredIpAllowlist,
  isRequestIpAllowed,
  isRequestOriginAllowed,
  requestIp,
} from './ipAccess.ts';
import { isRequestAuthenticated } from './auth.ts';
import { setSpeculativeRefillHandler } from './speculation.ts';
import { sweepOrphanedImages } from './images.ts';
import { initMediaWorker, stopMediaWorker } from './mediaWorker.ts';
import { initMediaThumbnails, stopMediaThumbnails } from './mediaThumbnails.ts';
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
const CLIENT_DIST = process.env.CLIENT_DIST ?? '';

// Backstop for image-file deletion guarantees (crash windows, late renders).
initMediaWorker();
sweepOrphanedImages();
initMediaThumbnails();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveFile(
  res: ServerResponse,
  path: string,
  immutable: boolean,
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
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
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
    if (path && (await serveFile(res, path, false, { 'cache-control': 'private, no-store' })))
      return;
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
        true,
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

  if (CLIENT_DIST) {
    const path = safeJoin(CLIENT_DIST, pathname === '/' ? '/index.html' : pathname);
    const immutable = pathname.startsWith('/assets/');
    if (path && (await serveFile(res, path, immutable))) return;
    // SPA fallback for client-side routes.
    if (req.method === 'GET' && !extname(pathname)) {
      if (await serveFile(res, join(CLIENT_DIST, 'index.html'), false)) return;
    }
  }
  res.writeHead(404).end('not found');
}

function onRequest(req: IncomingMessage, res: ServerResponse): void {
  handleRequest(req, res).catch((err) => {
    console.error('[http] unhandled error:', err);
    if (!res.writableEnded) res.writeHead(500).end();
  });
}

const certPath = process.env.TLS_CERT_PATH;
const keyPath = process.env.TLS_KEY_PATH;
let server: http.Server | https.Server;
let listener: net.Server;

if (certPath && keyPath) {
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    console.error(`TLS cert or key not found (${certPath}, ${keyPath})`);
    process.exit(1);
  }
  const readContext = () => ({ cert: readFileSync(certPath), key: readFileSync(keyPath) });
  const tlsServer = https.createServer(readContext(), onRequest);
  server = tlsServer;
  // Hot-reload the certificate on renewal without dropping the process.
  let reloadTimer: NodeJS.Timeout | null = null;
  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      try {
        tlsServer.setSecureContext(readContext());
        console.log('[tls] certificate reloaded');
      } catch (err) {
        console.error('[tls] certificate reload failed:', err);
      }
    }, 1000);
  };
  for (const file of [certPath, keyPath]) {
    try {
      watch(file, scheduleReload);
    } catch (err) {
      console.error(`[tls] cannot watch ${file}:`, err);
    }
  }
  // Browsers default to plain http for bare IP:port URLs; sniff the first byte
  // (0x16 = TLS handshake) and redirect http requests to https on the same port.
  const redirect = http.createServer((req, res) => {
    res
      .writeHead(301, { location: `https://${req.headers.host ?? 'localhost'}${req.url ?? '/'}` })
      .end();
  });
  listener = net.createServer((socket) => {
    // Bound sockets held by peers that never send the first byte.
    const sniffTimeout = setTimeout(() => socket.destroy(), 10_000);
    socket.once('readable', () => {
      clearTimeout(sniffTimeout);
      const first = socket.read(1) as Buffer | null;
      if (!first) {
        socket.destroy();
        return;
      }
      socket.unshift(first);
      (first[0] === 0x16 ? tlsServer : redirect).emit('connection', socket);
    });
    socket.once('close', () => clearTimeout(sniffTimeout));
    socket.on('error', () => socket.destroy());
  });
  console.log('[tls] HTTPS enabled (plain http redirects)');
} else {
  server = http.createServer(onRequest);
  listener = server;
}

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
setSpeculativeRefillHandler((conversationId) => {
  const subscribed = subscribedConversationIds();
  const targets =
    conversationId == null
      ? subscribed
      : subscribed.includes(conversationId)
        ? [conversationId]
        : [];
  for (const id of targets) prepareActiveSwipe(id);
});
initWebSocket(server as http.Server);

listener.listen(PORT, () => {
  console.log(
    `tinytavern server listening on ${certPath && keyPath ? 'https' : 'http'}://0.0.0.0:${PORT}`,
  );
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
