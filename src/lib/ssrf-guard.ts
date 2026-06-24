import { lookup } from 'dns/promises';
import net from 'net';

/**
 * SSRF guard. The platform fetches user-supplied URLs (health checks, notification
 * webhooks, CMS sync). Without validation a user could point those at cloud metadata
 * (169.254.169.254), loopback, or internal services. assertPublicUrl() rejects any URL
 * that resolves to a private/internal address before the request is made (H-7).
 *
 * Note: this validates the host at call time. To also defend against DNS-rebinding and
 * redirect-based bypass, callers should disable or re-validate redirects (`redirect: 'manual'`).
 */

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // unparseable → treat as unsafe
  }
  const [a, b] = parts;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  if (addr.startsWith('fe80')) return true; // link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique local fc00::/7
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateAddress(ip: string): boolean {
  return net.isIPv6(ip) ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

/**
 * Validate that a URL is http(s) and resolves only to public addresses.
 * Throws an Error if the URL is invalid, uses a blocked scheme, or maps to a
 * private/internal address. Returns the parsed URL on success.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Blocked URL scheme: ${url.protocol}`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error('Blocked private/internal address');
    }
    return url;
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error('DNS resolution failed');
  }

  if (addresses.length === 0) {
    throw new Error('DNS resolution failed');
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error('Blocked private/internal address');
    }
  }

  return url;
}

/** Boolean convenience wrapper around assertPublicUrl. */
export async function isPublicUrl(rawUrl: string): Promise<boolean> {
  try {
    await assertPublicUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}
