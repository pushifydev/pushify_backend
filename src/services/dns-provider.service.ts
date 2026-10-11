import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { dnsProviderConnections } from '../db/schema/dns-providers';
import { organizationRepository } from '../repositories/organization.repository';
import { encrypt, decrypt } from '../lib/encryption';
import {
  CloudflareDnsError,
  createCustomDomainRecords,
  maskToken,
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
      return { status: 'created', proxied, zone, records };
    } catch (err) {
      const message = err instanceof CloudflareDnsError ? err.message : 'Unexpected error while creating the Cloudflare DNS record';
      logger.warn(
        { organizationId, domain, token: maskToken(token), error: err instanceof Error ? err.message : String(err) },
        'Cloudflare DNS record creation failed — domain continues with manual DNS'
      );
      return { status: 'failed', proxied, message: `${message}. Add the DNS record manually.` };
    }
  },
};
