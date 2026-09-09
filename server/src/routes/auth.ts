import {
  clearSession,
  isPasswordConfigured,
  isRequestAuthenticated,
  passwordMatches,
  startSession,
} from '../http/auth.ts';
import { requestIp } from '../http/ipAccess.ts';
import { route, HttpError } from '../http/router.ts';
import { objectBody } from '../http/validation.ts';

const failures = new Map<string, { count: number; lastAt: number; blockedUntil: number }>();
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const BLOCK_MS = 30 * 1000;

route.get('/api/auth/status', ({ req }) => ({
  required: isPasswordConfigured(),
  authenticated: isRequestAuthenticated(req),
}));

route.post(
  '/api/auth/login',
  ({ req, headers, body, remoteAddress }) => {
    if (!isPasswordConfigured()) return { authenticated: true };
    const ip = requestIp(req, remoteAddress) ?? 'unknown';
    const now = Date.now();
    const previous = failures.get(ip);
    if (previous && previous.blockedUntil > now) {
      throw new HttpError(429, 'too many failed attempts; try again shortly');
    }

    const password = objectBody(body).password;
    if (typeof password !== 'string' || password.length > 1024 || !passwordMatches(password)) {
      const count = previous && now - previous.lastAt < FAILURE_WINDOW_MS ? previous.count + 1 : 1;
      failures.set(ip, {
        count: count >= 5 ? 0 : count,
        lastAt: now,
        blockedUntil: count >= 5 ? now + BLOCK_MS : 0,
      });
      throw new HttpError(401, 'incorrect password');
    }

    failures.delete(ip);
    startSession(req, headers);
    return { authenticated: true };
  },
  { maxBodyBytes: 4096 },
);

route.post('/api/auth/logout', ({ req, headers }) => {
  clearSession(req, headers);
  return { authenticated: false };
});
