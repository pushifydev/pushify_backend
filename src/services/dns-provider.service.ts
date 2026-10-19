import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { dnsProviderConnections } from '../db/schema/dns-providers';
import { organizationRepository } from '../repositories/organization.repository';
import { encrypt, decrypt } from '../lib/encryption';
import {
  CloudflareDnsError,
  createCustomDomainRecords,
  deleteCustomDomainRecords,
  maskToken,
  syncCustomDomainRecords,
  verifyCloudflareToken,
  type CreatedRecord,
} from '../lib/cloudflare-org-dns';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';

/**
 * Organization DNS provider (Cloudflare) connection. Owners and admins manage it; the token is
 * write-only — stored encrypted, shown only as a masked hint, never logged in full.
 */

const PROVIDER = 'cloudflare';

/**
 * A proxied record resolves to Cloudflare, not to the server, so Pushify's verify step (which
 * compares the A record with the server IP) and the HTTP-01 certificate request can't see the
 * server behind it. Returned with every proxied record so the user knows what to do.
 */
export const PROXIED_HTTPS_NOTE =
  'The record is proxied through Cloudflare, so the domain resolves to Cloudflare instead of the server and ' +
  "Pushify's DNS check and Let's Encrypt (HTTP-01) certificate cannot complete. Turn the proxy off in Cloudflare " +
  'until the domain is verified and has its certificate, then turn it back on with SSL/TLS mode "Full (strict)". ' +
  'A DNS-01 challenge would avoid this step, but Pushify does not issue certificates that way yet.';

export interface CloudflareConnectionStatus {
  connected: boolean;
  tokenHint: string | null;
  updatedAt: Date | null;
}

export interface DomainDnsResult {
  status: 'created' | 'skipped' | 'failed';
  proxied: boolean;
  zone?: string;
  records?: CreatedRecord[];
  /** Why it was skipped or failed — the domain is still added; DNS is then set up by hand. */
  message?: string;
}

export interface DomainDnsSyncResult {
  domain: string;
  /** skipped: Cloudflare not connected or no server IP; unchanged: nothing to do (or not Pushify's records). */
  status: 'updated' | 'unchanged' | 'skipped' | 'failed';
  updated?: number;
  created?: number;
  deleted?: number;
  message?: string;
}

async function assertCanManage(organizationId: string, userId: string, locale: SupportedLocale) {
  const membership = await organizationRepository.findMember(organizationId, userId);
  if (!membership) {
    throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
  }
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
  }
}

async function findRow(organizationId: string) {
  const [row] = await db
    .select()
    .from(dnsProviderConnections)
    .where(and(eq(dnsProviderConnections.organizationId, organizationId), eq(dnsProviderConnections.provider, PROVIDER)))
    .limit(1);
  return row ?? null;
}

export const dnsProviderService = {
  async getCloudflare(organizationId: string, userId: string, locale: SupportedLocale): Promise<CloudflareConnectionStatus> {
    await assertCanManage(organizationId, userId, locale);
    const row = await findRow(organizationId);
    if (!row) return { connected: false, tokenHint: null, updatedAt: null };
    let hint: string | null = null;
    try {
      hint = maskToken(decrypt(row.apiTokenEncrypted));
    } catch {
      hint = null;
    }
    return { connected: true, tokenHint: hint, updatedAt: row.updatedAt };
  },

  /** Store (or replace) the organization's Cloudflare token after checking it with Cloudflare. */
  async setCloudflare(
    organizationId: string,
    userId: string,
    input: { apiToken?: unknown },
    locale: SupportedLocale
  ): Promise<CloudflareConnectionStatus> {
    await assertCanManage(organizationId, userId, locale);
    const token = typeof input?.apiToken === 'string' ? input.apiToken.trim() : '';
    if (!token || token.length > 512 || /\s/.test(token)) {
      throw new HTTPException(400, { message: 'A Cloudflare API token is required' });
    }

    let valid: boolean;
    try {
      valid = await verifyCloudflareToken(token);
    } catch (err) {
      throw new HTTPException(502, { message: err instanceof Error ? err.message : 'Could not reach Cloudflare' });
    }
    if (!valid) {
      throw new HTTPException(400, { message: 'Cloudflare rejected this API token (it is invalid, expired or disabled)' });
    }

    const encrypted = encrypt(token);
    const existing = await findRow(organizationId);
    if (existing) {
      await db
        .update(dnsProviderConnections)
        .set({ apiTokenEncrypted: encrypted, updatedAt: new Date() })
        .where(eq(dnsProviderConnections.id, existing.id));
    } else {
      await db.insert(dnsProviderConnections).values({ organizationId, provider: PROVIDER, apiTokenEncrypted: encrypted });
    }
    logger.info({ organizationId, token: maskToken(token) }, 'Cloudflare DNS token saved');
    return { connected: true, tokenHint: maskToken(token), updatedAt: new Date() };
  },

  async removeCloudflare(organizationId: string, userId: string, locale: SupportedLocale): Promise<{ removed: boolean }> {
    await assertCanManage(organizationId, userId, locale);
    const deleted = await db
      .delete(dnsProviderConnections)
      .where(and(eq(dnsProviderConnections.organizationId, organizationId), eq(dnsProviderConnections.provider, PROVIDER)))
      .returning({ id: dnsProviderConnections.id });
    return { removed: deleted.length > 0 };
  },

  /**
   * Create the DNS record(s) for a newly added custom domain. Never throws: any problem comes
   * back as status 'failed' with a message, and adding the domain carries on as the manual flow.
   */
  async createRecordsForDomain(
    organizationId: string,
    domain: string,
    server: { ipv4?: string | null; ipv6?: string | null } | null,
    proxied = false
  ): Promise<DomainDnsResult> {
    let row;
    try {
      row = await findRow(organizationId);
    } catch (err) {
      logger.warn({ organizationId, domain, err }, 'Could not load Cloudflare DNS connection');
      return { status: 'failed', proxied, message: 'Could not load the Cloudflare connection; add the DNS record manually' };
    }
    if (!row) return { status: 'skipped', proxied, message: 'Cloudflare is not connected for this organization' };
    if (!server || (!server.ipv4 && !server.ipv6)) {
      return { status: 'skipped', proxied, message: 'The app has no server IP yet; add the DNS record manually once it does' };
    }

    let token: string;
    try {
      token = decrypt(row.apiTokenEncrypted);
    } catch {
      return { status: 'failed', proxied, message: 'The stored Cloudflare token could not be read; reconnect Cloudflare' };
    }

    try {
      const { zone, records } = await createCustomDomainRecords(token, { domain, ipv4: server.ipv4, ipv6: server.ipv6, proxied });
      logger.info({ organizationId, domain, zone, proxied, token: maskToken(token) }, 'Cloudflare DNS records created');
      return proxied
        ? { status: 'created', proxied, zone, records, message: PROXIED_HTTPS_NOTE }
        : { status: 'created', proxied, zone, records };
    } catch (err) {
      const message = err instanceof CloudflareDnsError ? err.message : 'Unexpected error while creating the Cloudflare DNS record';
      logger.warn(
        { organizationId, domain, token: maskToken(token), error: err instanceof Error ? err.message : String(err) },
        'Cloudflare DNS record creation failed — domain continues with manual DNS'
      );
      return { status: 'failed', proxied, message: `${message}. Add the DNS record manually.` };
    }
  },

  /**
   * Delete the records Pushify created for a custom domain that is being removed. Never throws:
   * the domain is already gone from Pushify, so a Cloudflare problem is only logged.
   */
  async deleteRecordsForDomain(organizationId: string, domain: string): Promise<{ deleted: number; message?: string }> {
    let token: string;
    try {
      const row = await findRow(organizationId);
      if (!row) return { deleted: 0 };
      token = decrypt(row.apiTokenEncrypted);
    } catch (err) {
      logger.warn(
        { organizationId, domain, error: err instanceof Error ? err.message : String(err) },
        'Could not load Cloudflare DNS connection'
      );
      return { deleted: 0, message: `Could not load the Cloudflare connection. Remove the DNS record for ${domain} in Cloudflare manually.` };
    }
    try {
      const deleted = await deleteCustomDomainRecords(token, domain);
      if (deleted > 0) logger.info({ organizationId, domain, deleted, token: maskToken(token) }, 'Cloudflare DNS records deleted');
      return { deleted };
    } catch (err) {
      logger.warn(
        { organizationId, domain, token: maskToken(token), error: err instanceof Error ? err.message : String(err) },
        'Cloudflare DNS record deletion failed — remove the record in Cloudflare manually'
      );
      const reason = err instanceof CloudflareDnsError ? err.message : 'Unexpected error while deleting the Cloudflare DNS record';
      return { deleted: 0, message: `${reason}. Remove the DNS record for ${domain} in Cloudflare manually.` };
    }
  },

  /**
   * Re-point the records Pushify created for a custom domain at the server's current IPv4/IPv6
   * (the server's IP changed, or the app moved to another server). Never throws: a problem comes
   * back as status 'failed' with a message saying what to fix by hand.
   */
  async syncRecordsForDomain(
    organizationId: string,
    domain: string,
    server: { ipv4?: string | null; ipv6?: string | null } | null
  ): Promise<DomainDnsSyncResult> {
    if (!server?.ipv4) return { domain, status: 'skipped' };
    let token: string;
    try {
      const row = await findRow(organizationId);
      if (!row) return { domain, status: 'skipped' };
      token = decrypt(row.apiTokenEncrypted);
    } catch (err) {
      logger.warn(
        { organizationId, domain, error: err instanceof Error ? err.message : String(err) },
        'Could not load Cloudflare DNS connection'
      );
      return { domain, status: 'failed', message: `Could not load the Cloudflare connection. Update the DNS record for ${domain} manually.` };
    }
    try {
      const result = await syncCustomDomainRecords(token, { domain, ipv4: server.ipv4, ipv6: server.ipv6 });
      const changed = result.updated + result.created + result.deleted;
      if (changed > 0) logger.info({ organizationId, domain, ...result, token: maskToken(token) }, 'Cloudflare DNS records synced');
      return { domain, status: changed > 0 ? 'updated' : 'unchanged', ...result };
    } catch (err) {
      logger.warn(
        { organizationId, domain, token: maskToken(token), error: err instanceof Error ? err.message : String(err) },
        'Cloudflare DNS record sync failed — update the record in Cloudflare manually'
      );
      const reason = err instanceof CloudflareDnsError ? err.message : 'Unexpected error while updating the Cloudflare DNS record';
      return { domain, status: 'failed', message: `${reason}. Update the DNS record for ${domain} in Cloudflare manually.` };
    }
  },
};
