/**
 * DNS records for an organization's own custom domains, with the organization's own Cloudflare
 * API token (dns-provider.service). Unlike lib/cloudflare-dns.ts — the platform's zone, configured
 * by env — the zone here is found from the domain itself, and the token comes from the caller.
 *
 * The token is only ever sent in the Authorization header: it never appears in an error message
 * or a log line (use maskToken when a hint is needed).
 *
 * An existing record with the same name and type is someone's decision and is reported as a
 * conflict instead of being overwritten. Only the records Pushify created (marked with
 * ORG_RECORD_COMMENT) are ever changed — re-pointed when the server's IP changes — or deleted
 * when the domain is removed.
 */

const API = 'https://api.cloudflare.com/client/v4';
export const ORG_RECORD_COMMENT = 'pushify:custom-domain';

export class CloudflareDnsError extends Error {
  constructor(message: string, readonly code: 'invalid_token' | 'zone_not_found' | 'conflict' | 'api_error') {
    super(message);
    this.name = 'CloudflareDnsError';
  }
}

/** `abcd…wxyz` — enough to tell tokens apart, useless to anyone reading a log. */
export function maskToken(token: string | null | undefined): string {
  if (!token) return '';
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

async function cf<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new CloudflareDnsError(`Could not reach Cloudflare: ${(err as Error).message}`, 'api_error');
  }
  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; result?: T; errors?: Array<{ code?: number; message: string }> }
    | null;
  if (!res.ok || !body?.success) {
    const detail = body?.errors?.[0]?.message || `HTTP ${res.status}`;
    if (res.status === 401) {
      throw new CloudflareDnsError(`Cloudflare rejected the API token: ${detail}`, 'invalid_token');
    }
    if (res.status === 403) {
      throw new CloudflareDnsError(
        `Cloudflare rejected the API token: ${detail} (check that it is active and has the Zone → Zone: Read and Zone → DNS: Edit permissions for this zone)`,
        'invalid_token'
      );
    }
    throw new CloudflareDnsError(`Cloudflare ${init.method || 'GET'} request failed: ${detail}`, 'api_error');
  }
  return body.result as T;
}

/** True when Cloudflare reports the token as active. */
export async function verifyCloudflareToken(token: string): Promise<boolean> {
  try {
    const result = await cf<{ status?: string }>(token, '/user/tokens/verify');
    return result?.status === 'active';
  } catch (err) {
    if (err instanceof CloudflareDnsError && err.code === 'invalid_token') return false;
    throw err;
  }
}

/** `a.b.example.com` → [`a.b.example.com`, `b.example.com`, `example.com`] */
export function zoneCandidates(domain: string): string[] {
  const labels = domain.toLowerCase().replace(/\.$/, '').split('.');
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** The most specific zone the token can see that contains `domain`. */
export async function findZone(token: string, domain: string): Promise<{ id: string; name: string } | null> {
  for (const name of zoneCandidates(domain)) {
    const zones = await cf<Array<{ id: string; name: string }>>(token, `/zones?name=${encodeURIComponent(name)}&per_page=5`);
    const zone = zones?.find((z) => z.name === name);
    if (zone) return { id: zone.id, name: zone.name };
  }
  return null;
}

export interface CreateRecordsInput {
  domain: string;
  ipv4?: string | null;
  ipv6?: string | null;
  proxied?: boolean;
}

export interface CreatedRecord {
  id: string;
  type: 'A' | 'AAAA';
  content: string;
  proxied: boolean;
}

/**
 * Create the A (and AAAA, when the server has IPv6) record for `domain` in its zone. Proxy is off
 * unless asked for. Throws CloudflareDnsError with a message fit for the user.
 */
export async function createCustomDomainRecords(token: string, input: CreateRecordsInput): Promise<{ zone: string; records: CreatedRecord[] }> {
  const domain = input.domain.toLowerCase();
  const proxied = input.proxied === true;
  const wanted: Array<{ type: 'A' | 'AAAA'; content: string }> = [];
  if (input.ipv4) wanted.push({ type: 'A', content: input.ipv4 });
  if (input.ipv6) wanted.push({ type: 'AAAA', content: input.ipv6 });
  if (wanted.length === 0) throw new CloudflareDnsError('The server has no IP address to point the record at', 'api_error');

  const zone = await findZone(token, domain);
  if (!zone) {
    throw new CloudflareDnsError(`No Cloudflare zone for ${domain} is accessible with this API token`, 'zone_not_found');
  }

  // Check every type first so a conflict leaves the zone untouched rather than half-done.
  for (const record of wanted) {
    const existing = await cf<Array<{ id: string }>>(
      token,
      `/zones/${zone.id}/dns_records?type=${record.type}&name=${encodeURIComponent(domain)}&per_page=5`
    );
    if (existing && existing.length > 0) {
      throw new CloudflareDnsError(`A ${record.type} record for ${domain} already exists in Cloudflare; it was left unchanged`, 'conflict');
    }
  }

  const records: CreatedRecord[] = [];
  for (const record of wanted) {
    const created = await cf<{ id: string; proxied?: boolean }>(token, `/zones/${zone.id}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({ type: record.type, name: domain, content: record.content, proxied, ttl: 1, comment: ORG_RECORD_COMMENT }),
    });
    records.push({ id: created?.id, type: record.type, content: record.content, proxied: created?.proxied ?? proxied });
  }
  return { zone: zone.name, records };
}

/**
 * Delete the A/AAAA records Pushify created for `domain` (createCustomDomainRecords). Records
 * without Pushify's comment belong to someone else and are left alone. Returns how many were
 * deleted; 0 when the token can't see the zone. Throws CloudflareDnsError on API errors.
 */
export async function deleteCustomDomainRecords(token: string, domain: string): Promise<number> {
  const name = domain.toLowerCase().replace(/\.$/, '');
  const zone = await findZone(token, name);
  if (!zone) return 0;
  let deleted = 0;
  for (const type of ['A', 'AAAA'] as const) {
    const records = await cf<Array<{ id: string; comment?: string | null }>>(
      token,
      `/zones/${zone.id}/dns_records?type=${type}&name=${encodeURIComponent(name)}&per_page=20`
    );
    for (const record of records || []) {
      if (record.comment !== ORG_RECORD_COMMENT) continue;
      await cf(token, `/zones/${zone.id}/dns_records/${record.id}`, { method: 'DELETE' });
      deleted++;
    }
  }
  return deleted;
}

export interface SyncRecordsResult {
  updated: number;
  created: number;
  deleted: number;
}

/**
 * Point the records Pushify created for `domain` at the server's current addresses — after the
 * server's IP changed or the app moved to another server. Only records with Pushify's comment
 * are touched: a name without one isn't managed by Pushify and is left as it is. Changed records
 * keep their proxy setting. A newly gained IPv6 gets an AAAA record only when the name has no
 * AAAA record at all; a lost one removes Pushify's AAAA record. Without an IPv4 nothing is
 * touched. Throws CloudflareDnsError.
 */
export async function syncCustomDomainRecords(
  token: string,
  input: { domain: string; ipv4?: string | null; ipv6?: string | null }
): Promise<SyncRecordsResult> {
  const result: SyncRecordsResult = { updated: 0, created: 0, deleted: 0 };
  // A server without IPv4 is unfinished or mid-change (Pushify reaches every server over IPv4),
  // not a decision to drop the domain's DNS: leave the records as they are.
  if (!input.ipv4) return result;
  const name = input.domain.toLowerCase().replace(/\.$/, '');
  const zone = await findZone(token, name);
  if (!zone) return result;

  type Rec = { id: string; content: string; proxied?: boolean; comment?: string | null };
  const types = ['A', 'AAAA'] as const;
  const all: Record<'A' | 'AAAA', Rec[]> = { A: [], AAAA: [] };
  for (const type of types) {
    all[type] =
      (await cf<Rec[]>(token, `/zones/${zone.id}/dns_records?type=${type}&name=${encodeURIComponent(name)}&per_page=20`)) || [];
  }
  const ours = (type: 'A' | 'AAAA') => all[type].filter((r) => r.comment === ORG_RECORD_COMMENT);
  const managed = [...ours('A'), ...ours('AAAA')];
  if (managed.length === 0) return result;
  const proxied = managed[0].proxied === true;

  for (const type of types) {
    const wanted = type === 'A' ? input.ipv4 : input.ipv6;
    if (!wanted) {
      for (const record of ours(type)) {
        await cf(token, `/zones/${zone.id}/dns_records/${record.id}`, { method: 'DELETE' });
        result.deleted++;
      }
      continue;
    }
    if (all[type].length === 0) {
      await cf(token, `/zones/${zone.id}/dns_records`, {
        method: 'POST',
        body: JSON.stringify({ type, name, content: wanted, proxied, ttl: 1, comment: ORG_RECORD_COMMENT }),
      });
      result.created++;
      continue;
    }
    for (const record of ours(type)) {
      if (record.content === wanted) continue;
      await cf(token, `/zones/${zone.id}/dns_records/${record.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: wanted }),
      });
      result.updated++;
    }
  }
  return result;
}
