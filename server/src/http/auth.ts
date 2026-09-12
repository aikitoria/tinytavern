import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { isTrustedProxy } from './proxy.ts';
import { stmt } from '../db/db.ts';

const PASSWORD_KEY = 'access_password_hash';
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'tinytavern_session';
if (!/^[a-zA-Z0-9_]+$/.test(SESSION_COOKIE)) throw new Error('Invalid SESSION_COOKIE_NAME');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PASSWORD_LENGTH = 1024;

function sessionHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

// Prune abandoned sessions at startup; requests still check expiry individually.
stmt('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());

function storedPasswordHash(): string | null {
  const row = stmt('SELECT value FROM settings WHERE key = ?').get(PASSWORD_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

export function isPasswordConfigured(): boolean {
  return storedPasswordHash() !== null;
}

export function validateNewPassword(password: unknown): asserts password is string | null {
  if (password !== null && typeof password !== 'string') {
    throw new TypeError('accessPassword must be a string or null');
  }
  if (password === '') throw new TypeError('accessPassword must not be empty');
  if (password !== null && password.length > MAX_PASSWORD_LENGTH) {
    throw new TypeError(`accessPassword must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt-v1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [version, saltText, hashText, extra] = encoded.split('$');
  if (version !== 'scrypt-v1' || !saltText || !hashText || extra !== undefined) return false;
  try {
    const salt = Buffer.from(saltText, 'base64');
    const expected = Buffer.from(hashText, 'base64');
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = scryptSync(password, salt, expected.length, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Changing or removing the password revokes all sessions. */
export function setAccessPassword(password: string | null): void {
  validateNewPassword(password);
  if (password === null) stmt('DELETE FROM settings WHERE key = ?').run(PASSWORD_KEY);
  else {
    stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      PASSWORD_KEY,
      hashPassword(password),
    );
  }
  stmt('DELETE FROM auth_sessions').run();
}

function cookieValue(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function validSession(req: Request): boolean {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return false;
  const tokenHash = sessionHash(token);
  const session = stmt('SELECT expires_at FROM auth_sessions WHERE token_hash = ?').get(tokenHash) as
    { expires_at: number } | undefined;
  if (!session) return false;
  if (session.expires_at <= Date.now()) {
    stmt('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
    return false;
  }
  return true;
}

export function isRequestAuthenticated(req: Request): boolean {
  return !isPasswordConfigured() || validSession(req);
}

export function passwordMatches(password: string): boolean {
  const encoded = storedPasswordHash();
  return encoded !== null && verifyPassword(password, encoded);
}

function cookieSecurity(req: Request): string {
  return new URL(req.url).protocol === 'https:' ||
    (isTrustedProxy(req) && req.headers.get('x-forwarded-proto') === 'https')
    ? '; Secure'
    : '';
}

export function startSession(req: Request, headers: Headers): void {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  stmt('INSERT INTO auth_sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)').run(
    sessionHash(token),
    now + SESSION_TTL_MS,
    now,
  );
  headers.set(
    'set-cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${cookieSecurity(req)}`,
  );
}

export function clearSession(req: Request, headers: Headers): void {
  const token = cookieValue(req, SESSION_COOKIE);
  if (token) stmt('DELETE FROM auth_sessions WHERE token_hash = ?').run(sessionHash(token));
  headers.set('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieSecurity(req)}`);
}
