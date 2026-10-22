import { isIP } from 'node:net';

export interface ServerAddress {
  address: string;
  family: 4 | 6;
}

/**
 * The address a self-hosted (BYOS) server is reached at: an IPv4 or IPv6 literal. IPv6 may come in
 * URL form (`[2001:db8::1]`); the brackets are dropped and the address lowercased, so what is stored
 * is the bare address SSH connects to. A zone-scoped address (`fe80::1%eth0`) only means something on
 * the sender's own link, so it is rejected like anything else that is not an IP.
 */
export function parseServerAddress(value: unknown): ServerAddress | null {
  if (typeof value !== 'string') return null;
  let address = value.trim();
  const bracketed = address.startsWith('[') && address.endsWith(']');
  if (bracketed) address = address.slice(1, -1);
  if (address.includes('%')) return null;

  const family = isIP(address);
  if (family === 6) return { address: address.toLowerCase(), family };
  if (family === 4 && !bracketed) return { address, family };
  return null;
}

/**
 * `host` as a socket (and ssh2) takes it: an IPv6 literal without the URL brackets, which would
 * otherwise be looked up as a hostname. Anything else is returned unchanged.
 */
export function sshConnectHost(host: string): string {
  if (host.startsWith('[') && host.endsWith(']') && isIP(host.slice(1, -1)) === 6) {
    return host.slice(1, -1);
  }
  return host;
}

/**
 * The command a user runs to SSH into the server with the downloaded key. OpenSSH reads the host of
 * `user@host` as-is (that form has no port), so an IPv6 literal goes in bare: `root@[2001:db8::1]`
 * would be looked up as a hostname. A non-default port is passed with `-p`.
 */
export function buildSshConnectCommand(opts: {
  keyFile: string;
  host: string;
  username?: string;
  port?: number;
}): string {
  const port = opts.port ?? 22;
  const portFlag = port === 22 ? '' : ` -p ${port}`;
  return `ssh -i ${opts.keyFile}${portFlag} ${opts.username ?? 'root'}@${sshConnectHost(opts.host)}`;
}
