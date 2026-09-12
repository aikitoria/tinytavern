import { behindCaddy, isTrustedProxy } from './proxy.ts';
import { BlockList, isIP } from 'node:net';

export const DEFAULT_IP_ALLOWLIST = '127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fe80::/10';

/** Strips IPv6 zone ids ("fe80::1%eth0") and unwraps v4-mapped addresses. */
export function normalizeAddress(address: string): string {
  const zone = address.indexOf('%');
  const withoutZone = zone === -1 ? address : address.slice(0, zone);
  return withoutZone.toLowerCase().startsWith('::ffff:') ? withoutZone.slice(7) : withoutZone;
}

export interface IpAllowlist {
  configured: string;
  isAllowed(address: string | undefined): boolean;
}

/** Shared with the Vite dev server. */
export function createIpAllowlist(env: string | undefined): IpAllowlist {
  const configured = env === undefined ? DEFAULT_IP_ALLOWLIST : env.trim();
  // Empty disables the IP layer; unset retains private-network defaults.
  if (configured === '') {
    return { configured, isAllowed: () => true };
  }
  const list = new BlockList();
  for (const rawEntry of configured.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const slash = entry.lastIndexOf('/');
    const address = normalizeAddress(slash === -1 ? entry : entry.slice(0, slash));
    const family = isIP(address);
    if (!family) throw new Error(`Invalid address in TINYTAVERN_IP_ALLOWLIST: ${entry}`);
    const maxPrefix = family === 4 ? 32 : 128;
    // Strict digit check: Number('') is 0, so a trailing "/" would silently become /0.
    const rawPrefix = slash === -1 ? null : entry.slice(slash + 1);
    if (rawPrefix !== null && !/^\d+$/.test(rawPrefix)) {
      throw new Error(`Invalid prefix in TINYTAVERN_IP_ALLOWLIST: ${entry}`);
    }
    const prefix = rawPrefix === null ? maxPrefix : Number(rawPrefix);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      throw new Error(`Invalid prefix in TINYTAVERN_IP_ALLOWLIST: ${entry}`);
    }
    list.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return {
    configured,
    isAllowed(address) {
      const normalized = address ? normalizeAddress(address) : '';
      const family = isIP(normalized);
      return family !== 0 && list.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
    },
  };
}

const allowlist = createIpAllowlist(process.env.TINYTAVERN_IP_ALLOWLIST);

export function requestIp(req: Request, remoteAddress?: string): string | null {
  const address = isTrustedProxy(req) ? req.headers.get('x-tinytavern-client-ip') : remoteAddress;
  return address ? normalizeAddress(address) : null;
}

export function isRequestIpAllowed(req: Request, remoteAddress?: string): boolean {
  return (!behindCaddy || isTrustedProxy(req)) && allowlist.isAllowed(requestIp(req, remoteAddress) ?? undefined);
}

function requestHostMatchesOrigin(host: string | null, origin: URL): boolean {
  if (!host) return false;
  const requestHost = host.trim().toLowerCase();
  const originHost = origin.host.toLowerCase();
  if (requestHost === originHost) return true;
  // URL.host omits a protocol's default port while HTTP Host may include it.
  const defaultPort = origin.protocol === 'https:' ? '443' : origin.protocol === 'http:' ? '80' : '';
  return defaultPort !== '' && requestHost === `${originHost}:${defaultPort}`;
}

/**
 * Require same-origin browser requests; allow clients without Origin or Fetch Metadata.
 */
export function isRequestOriginAllowed(req: Request): boolean {
  const rawOrigin = req.headers.get('origin');
  if (rawOrigin !== null) {
    try {
      const origin = new URL(rawOrigin);
      return (
        (origin.protocol === 'http:' || origin.protocol === 'https:') &&
        requestHostMatchesOrigin(req.headers.get('host'), origin)
      );
    } catch {
      return false;
    }
  }

  const fetchSite = req.headers.get('sec-fetch-site');
  return fetchSite === null || fetchSite === 'same-origin' || fetchSite === 'none';
}

export function configuredIpAllowlist(): string {
  return allowlist.configured || 'everyone';
}
