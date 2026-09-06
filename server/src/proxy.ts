import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';

const keyFile = process.env.CADDY_PROXY_KEY_FILE;
const token = keyFile ? readFileSync(keyFile, 'utf8').trim() : null;
if (token !== null && !/^[a-f0-9]{64}$/.test(token)) {
  throw new Error('CADDY_PROXY_KEY_FILE must contain 32 bytes encoded as lowercase hex');
}
const expected = token === null ? null : Buffer.from(token);
export const behindCaddy = expected !== null;

// Caddy overwrites this header. Backends publish no ports, and the private
// token also prevents other containers on ComfyUI's shared network spoofing it.
export function isTrustedProxy(req: IncomingMessage): boolean {
  const supplied = req.headers['x-minitavern-proxy'];
  return (
    expected !== null &&
    typeof supplied === 'string' &&
    /^[a-f0-9]{64}$/.test(supplied) &&
    timingSafeEqual(Buffer.from(supplied), expected)
  );
}
