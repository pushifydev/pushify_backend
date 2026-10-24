import net from 'net';

/**
 * IPv4/IPv6 address lists written as `100.64.0.0/10, 2001:db8::/32, 203.0.113.7`
 * (ADMIN_ALLOWED_CIDRS, ADMIN_TRUSTED_PROXY_CIDRS). Matching is done by Node's own BlockList.
 */
export interface CidrList {
  /** Number of entries; 0 means the variable was unset or empty */
  readonly size: number;
  contains(ip: string | null | undefined): boolean;
}

/**
 * Bare address for comparison: `::ffff:1.2.3.4` (an IPv4 client on a dual-stack socket) becomes
 * `1.2.3.4`; brackets, a port and an IPv6 zone are dropped. Null when it is not an IP address.
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) value = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(':'));
  if (value.includes(':')) value = value.replace(/%[\w.-]+$/, '');
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) value = mapped[1];
  return net.isIP(value) ? value.toLowerCase() : null;
}

/**
 * Parse a comma-separated list of addresses and CIDRs. A wrong entry throws instead of being
 * skipped: a typo must stop the API from starting, not quietly leave the panel open.
 */
export function parseCidrList(raw: string | undefined, name: string): CidrList {
  // One list per family: a single BlockList also matches IPv4 addresses against IPv6 rules
  // through their mapped form, so `::/0` would admit every IPv4 client too.
  const byFamily = { 4: new net.BlockList(), 6: new net.BlockList() };
  const entries = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const [address, prefix, ...rest] = entry.split('/');
    const family = net.isIP(address);
    const bits = family === 4 ? 32 : 128;
    const prefixLength = prefix === undefined ? bits : /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN;
    if (!family || address.includes('%') || rest.length > 0 || !(prefixLength >= 0 && prefixLength <= bits)) {
      throw new Error(`${name}: "${entry}" is not an IPv4/IPv6 address or CIDR (e.g. 100.64.0.0/10)`);
    }
    byFamily[family === 4 ? 4 : 6].addSubnet(address, prefixLength, family === 4 ? 'ipv4' : 'ipv6');
  }

  return {
    size: entries.length,
    contains(ip) {
      const address = normalizeIp(ip);
      if (!address) return false;
      const family = net.isIP(address) === 4 ? 4 : 6;
      try {
        return byFamily[family].check(address, family === 4 ? 'ipv4' : 'ipv6');
      } catch {
        return false;
      }
    },
  };
}
