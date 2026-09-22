import { env } from '../config/env';
import { logger } from './logger';

/**
 * DNS records for auto subdomains (`<project>.pushify.dev`) when the zone is on Cloudflare.
 *
 * The zone's wildcard record points at one host — the control plane — so an app on a shared
 * runner got no working subdomain at all. Each auto subdomain gets its own proxied A record to
 * the server that hosts the app instead (more specific than the wildcard, and one runner or many
 * alike). Configured by CLOUDFLARE_API_TOKEN (Zone → DNS → Edit on that zone only) and
 * CLOUDFLARE_ZONE_ID; without them nothing here runs and the wildcard record is all there is.
 *
 * A project's slug is user input: a project named `api` must never move `api.pushify.dev`. So
 * records are only ever created, changed or deleted when they carry OUR_COMMENT — anything else
 * with that name (the API, www, a record added by hand) is left alone and the subdomain is
 * reported as unavailable.
 */

const API = 'https://api.cloudflare.com/client/v4';
export const OUR_COMMENT = 'pushify:auto-subdomain';

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  comment?: string | null;
}

export function cloudflareDnsConfigured(): boolean {
  return !!(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ZONE_ID);
}

/**
 * Labels a project never gets as its auto subdomain (`api.pushify.dev` is the API): a project
 * whose slug is one of these gets `<slug>-<id>` instead (domain.service createAutoSubdomain).
 */
export const RESERVED_SUBDOMAIN_LABELS = new Set([
  'api', 'app', 'www', 'admin', 'dashboard', 'console', 'panel', 'auth', 'login', 'account',
  'billing', 'docs', 'help', 'support', 'status', 'blog', 'mail', 'email', 'smtp', 'imap',
  'ftp', 'vpn', 'ns', 'ns1', 'ns2', 'cdn', 'static', 'assets', 'media', 'img', 'git',
  'registry', 'dev', 'staging', 'stage', 'test', 'preview', 'internal', 'm',
]);

/**
 * Only names directly under the auto-subdomain base, e.g. `shop.pushify.dev`. (Existing records
 * such as the API's are protected by the ownership check, not by this.)
 */
function isManageable(name: string): boolean {
  const base = env.PREVIEW_BASE_URL;
  if (!base || !name.endsWith(`.${base}`)) return false;
  const label = name.slice(0, -(base.length + 1));
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

async function cf<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}/zones/${env.CLOUDFLARE_ZONE_ID}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: Array<{ message: string }> } | null;
  if (!res.ok || !body?.success) {
    throw new Error(`Cloudflare ${init.method || 'GET'} ${path}: ${body?.errors?.[0]?.message || res.status}`);
  }
  return body.result as T;
}

async function recordsNamed(name: string): Promise<CfRecord[]> {
  return cf<CfRecord[]>(`/dns_records?name=${encodeURIComponent(name)}&per_page=50`);
}

export type EnsureResult = 'created' | 'updated' | 'unchanged' | 'foreign' | 'skipped';

/**
 * Point `name` at `ip` (proxied A record). 'foreign' when a record we don't own has the name —
 * nothing is changed then.
 */
export async function ensureAutoSubdomainRecord(name: string, ip: string): Promise<EnsureResult> {
  if (!cloudflareDnsConfigured() || !isManageable(name)) return 'skipped';
  const existing = await recordsNamed(name);
  if (existing.some((r) => r.comment !== OUR_COMMENT)) {
    logger.warn({ name }, 'Auto subdomain name is taken by a DNS record Pushify does not own — left alone');
    return 'foreign';
  }
  const ours = existing.find((r) => r.type === 'A');
  if (ours && ours.content === ip && ours.proxied) return 'unchanged';
  const record = { type: 'A', name, content: ip, proxied: true, ttl: 1, comment: OUR_COMMENT };
  if (ours) {
    await cf(`/dns_records/${ours.id}`, { method: 'PATCH', body: JSON.stringify(record) });
    return 'updated';
  }
  await cf('/dns_records', { method: 'POST', body: JSON.stringify(record) });
  return 'created';
}

/** Remove our record(s) for `name`; records we don't own stay. */
export async function deleteAutoSubdomainRecord(name: string): Promise<number> {
  if (!cloudflareDnsConfigured() || !isManageable(name)) return 0;
  const ours = (await recordsNamed(name)).filter((r) => r.comment === OUR_COMMENT);
  for (const record of ours) {
    await cf(`/dns_records/${record.id}`, { method: 'DELETE' });
  }
  return ours.length;
}

/** Host name of a URL, or null (Node 20 has no URL.parse). */
export function hostnameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Best-effort delete for cleanup paths: never throws. */
export async function deleteAutoSubdomainRecordQuietly(name: string): Promise<void> {
  try {
    await deleteAutoSubdomainRecord(name);
  } catch (err) {
    logger.warn({ name, err }, 'Could not remove auto subdomain DNS record');
  }
}

/**
 * Empty the CDN's copy of a site after a deploy.
 *
 * Cloudflare sits in front of every auto subdomain (the records above are proxied), so a visitor
 * can be served the previous deploy's files from an edge cache until they expire — and with
 * fingerprinted assets now cached for a year, "until they expire" is not an option. Purging by
 * hostname empties only that site's copy, not the whole zone, so one project's deploy never
 * costs every other project its cache.
 *
 * Best effort by design: a cache that was not emptied is a stale page for a few minutes, not a
 * reason to fail a deploy that already succeeded. Needs the token to carry Cache Purge.
 */
export async function purgeCachedHostnames(hostnames: string[]): Promise<'purged' | 'skipped' | 'failed'> {
  const hosts = [...new Set(hostnames.map((host) => host.trim().toLowerCase()).filter(Boolean))];
  if (!cloudflareDnsConfigured() || hosts.length === 0) return 'skipped';

  try {
    // Cloudflare takes at most 30 hostnames per call
    for (let i = 0; i < hosts.length; i += 30) {
      await cf('/purge_cache', { method: 'POST', body: JSON.stringify({ hosts: hosts.slice(i, i + 30) }) });
    }
    return 'purged';
  } catch (err) {
    logger.warn({ err, hosts }, 'Cloudflare cache purge failed');
    return 'failed';
  }
}
