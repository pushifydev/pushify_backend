import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { parseCidrList, normalizeIp, type CidrList } from '../lib/ip-allowlist';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';

/**
 * Called from outside the operator's network by design, so ADMIN_ALLOWED_CIDRS never applies:
 * Git hosts and Stripe (webhooks, each verified by its signature), visitors of deployed apps
 * (nginx on every server proxies a sleeping app's 502 to the wake page) and health probes
 * (the compose healthcheck curls localhost; it would mark the API unhealthy otherwise).
 */
export const ALLOWLIST_EXEMPT_PREFIXES = ['/api/v1/webhooks', '/api/v1/wake', '/api/v1/health'] as const;

export function isAllowlistExemptPath(path: string): boolean {
  return ALLOWLIST_EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * The client address the allowlist checks. Starts from the socket peer and walks X-Forwarded-For
 * from the right only while the current hop is a trusted proxy, so the header is believed only
 * when a trusted proxy wrote it. A client that connects to the API port directly and sends its
 * own X-Forwarded-For is judged by its socket address. TRUSTED_PROXY_HOPS is not used here:
 * counting hops cannot tell a proxy from such a client. Null (refuse) when an entry is not an IP.
 */
export function resolveClientIp(
  socketIp: string | null | undefined,
  forwardedFor: string | null | undefined,
  trustedProxies: CidrList,
): string | null {
  let ip = normalizeIp(socketIp);
  if (!ip) return null;
  const hops = (forwardedFor ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  while (hops.length > 0 && trustedProxies.contains(ip)) {
    ip = normalizeIp(hops.pop());
    if (!ip) return null;
  }
  return ip;
}

function socketAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/**
 * Self-host: limit the API (dashboard calls, CLI, API keys, admin panel, WebSockets) to
 * ADMIN_ALLOWED_CIDRS, e.g. a Tailscale range. Everyone else gets 403. Returns null — nothing is
 * registered and behaviour is unchanged — when the list is unset or empty. Throws on a wrong entry.
 */
export function createAdminIpAllowlist(options: {
  allowedCidrs?: string;
  trustedProxyCidrs?: string;
}): MiddlewareHandler | null {
  const allowed = parseCidrList(options.allowedCidrs, 'ADMIN_ALLOWED_CIDRS');
  if (allowed.size === 0) return null;
  const trustedProxies = parseCidrList(options.trustedProxyCidrs, 'ADMIN_TRUSTED_PROXY_CIDRS');

  return async function adminIpAllowlist(c, next) {
    if (isAllowlistExemptPath(c.req.path)) return next();

    const socketIp = socketAddress(c);
    const ip = resolveClientIp(socketIp, c.req.header('x-forwarded-for'), trustedProxies);
    if (ip && allowed.contains(ip)) return next();

    logger.warn(
      { type: 'ip_not_allowed', requestId: c.get('requestId'), ip, socketIp, method: c.req.method, path: c.req.path },
      'Request refused: client address is not in ADMIN_ALLOWED_CIDRS',
    );
    const locale: SupportedLocale = c.get('locale') || 'en';
    return c.json({ error: { code: 'IP_NOT_ALLOWED', message: t(locale, 'errors', 'forbidden') } }, 403);
  };
}
