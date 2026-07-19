import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { infraWalletTransactions, organizations, projects, purchasedDomains, servers } from '../db/schema';
import { getRegistrar, type DnsRecordInput, type DnsRecordType } from '../lib/registrar';
import {
  domainMarginPercent,
  domainMaxPriceCents,
  retailFromWholesaleCents,
} from '../lib/domain-pricing';
import { resolveProjectServerId } from '../lib/runner-routing';
import { resolveBillingNotifyEmail } from '../lib/billing-notify';
import {
  sendDomainAuthCodeViewedEmail,
  sendDomainPurchasedEmail,
  sendDomainTransferStartedEmail,
} from '../lib/email';
import { logger } from '../lib/logger';
import { adminNotify } from './admin-notify.service';
import { infraBillingService } from './infra-billing.service';
import { domainService } from './domain.service';
import { t, type SupportedLocale } from '../i18n';

const DOMAIN_REGEX =
  /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** TLDs offered in keyword search (one availability call covers all of them). */
const SEARCH_TLDS = ['com', 'net', 'org', 'dev', 'app', 'io', 'co', 'me', 'xyz', 'ai'];

export const MAX_PURCHASE_YEARS = 5;

export interface DomainPurchaseQuote {
  domainName: string;
  years: number;
  /** Year-1 registration wholesale (USD cents) */
  wholesaleCents: number;
  renewalWholesaleCents: number | null;
  /** Registration + (years-1) renewals, wholesale (USD cents) */
  wholesaleTotalCents: number;
  /** What the customer pays for the whole term (USD cents) */
  retailTotalCents: number;
}

export interface DomainSearchResult {
  domainName: string;
  available: boolean;
  premium: boolean;
  /** Retail price in USD cents (null when unavailable/premium) */
  priceCents: number | null;
  /** Retail renewal price in USD cents when known */
  renewalPriceCents: number | null;
}

function normalizeKeyword(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\s+/g, '');
}

const DNS_RECORD_TYPES: DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS'];
const DNS_HOST_PATTERN = /^(@|\*|(\*\.)?[a-z0-9_]([a-z0-9_.-]{0,200}[a-z0-9_])?)$/i;
const NAMESERVER_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const EMAIL_BOX_PATTERN = /^[a-z0-9._+-]{1,64}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateDnsInput(record: {
  host?: unknown;
  type?: unknown;
  answer?: unknown;
  ttl?: unknown;
  priority?: unknown;
}): DnsRecordInput | null {
  const host = typeof record.host === 'string' ? record.host.trim() : '';
  const type = record.type as DnsRecordType;
  const answer = typeof record.answer === 'string' ? record.answer.trim() : '';
  if (host !== '' && !DNS_HOST_PATTERN.test(host)) return null;
  if (!DNS_RECORD_TYPES.includes(type)) return null;
  if (!answer || answer.length > 1024) return null;
  const ttl = record.ttl === undefined ? 300 : Number(record.ttl);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) return null;
  let priority: number | undefined;
  if (type === 'MX' || type === 'SRV') {
    priority = record.priority === undefined ? 10 : Number(record.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 65535) return null;
  }
  return { host: host || '@', type, answer, ttl, priority };
}

/** Credit back a failed charge. Uses `adjustment` so it never masquerades as a top-up. */
async function refundWallet(
  organizationId: string,
  amountCents: number,
  description: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const [org] = await tx
      .select({ balance: organizations.infraWalletBalanceCents })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    const newBalance = (org?.balance ?? 0) + amountCents;
    await tx
      .update(organizations)
      .set({ infraWalletBalanceCents: newBalance, updatedAt: new Date() })
      .where(eq(organizations.id, organizationId));
    await tx.insert(infraWalletTransactions).values({
      organizationId,
      type: 'adjustment',
      amountCents,
      balanceAfterCents: newBalance,
      description,
    });
  });
}

export const registrarDomainService = {
  isConfigured(): boolean {
    return getRegistrar() !== null;
  },

  async search(rawQuery: string, locale: SupportedLocale): Promise<DomainSearchResult[]> {
    const registrar = getRegistrar();
    if (!registrar) {
      throw new HTTPException(503, { message: t(locale, 'domains', 'registrarNotConfigured') });
    }
    const keyword = normalizeKeyword(rawQuery);
    if (!keyword) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'searchQueryRequired') });
    }

    let candidates: string[];
    if (keyword.includes('.')) {
      if (!DOMAIN_REGEX.test(keyword)) {
        throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
      }
      const base = keyword.split('.')[0];
      candidates = [
        keyword,
        ...SEARCH_TLDS.map((tld) => `${base}.${tld}`).filter((d) => d !== keyword),
      ];
    } else {
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(keyword)) {
        throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
      }
      candidates = SEARCH_TLDS.map((tld) => `${keyword}.${tld}`);
    }

    const margin = domainMarginPercent();
    const maxCents = domainMaxPriceCents();
    const availability = await registrar.checkAvailability(candidates);

    return availability.map((a) => {
      const purchasable =
        a.available && !a.premium && a.wholesaleCents !== null && a.wholesaleCents > 0;
      const retail = purchasable ? retailFromWholesaleCents(a.wholesaleCents!, margin) : null;
      return {
        domainName: a.domainName,
        available: purchasable && retail! <= maxCents,
        premium: a.premium,
        priceCents: retail !== null && retail <= maxCents ? retail : null,
        renewalPriceCents:
          purchasable && a.renewalWholesaleCents
            ? retailFromWholesaleCents(a.renewalWholesaleCents, margin)
            : null,
      };
    });
  },

  /**
   * Validate + price a purchase without buying. Multi-year terms are priced as
   * year-1 registration + (years-1) renewals, on both the wholesale and retail side.
   */
  async quote(domainNameRaw: string, years: number, locale: SupportedLocale): Promise<DomainPurchaseQuote> {
    const registrar = getRegistrar();
    if (!registrar) {
      throw new HTTPException(503, { message: t(locale, 'domains', 'registrarNotConfigured') });
    }

    const domainName = normalizeKeyword(domainNameRaw);
    if (!DOMAIN_REGEX.test(domainName)) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
    }
    if (!Number.isInteger(years) || years < 1 || years > MAX_PURCHASE_YEARS) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
    }

    const [alreadyOwned] = await db
      .select({ id: purchasedDomains.id })
      .from(purchasedDomains)
      .where(eq(purchasedDomains.domainName, domainName))
      .limit(1);
    if (alreadyOwned) {
      throw new HTTPException(409, { message: t(locale, 'domains', 'alreadyExists') });
    }

    // Live availability — search results may be stale
    const [availability] = await registrar.checkAvailability([domainName]);
    if (!availability?.available || !availability.wholesaleCents) {
      throw new HTTPException(409, { message: t(locale, 'domains', 'notAvailable') });
    }
    if (availability.premium) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'premiumNotSupported') });
    }

    const wholesaleCents = availability.wholesaleCents;
    const renewalWholesaleCents = availability.renewalWholesaleCents;
    const retailYear1 = retailFromWholesaleCents(wholesaleCents);
    if (retailYear1 > domainMaxPriceCents()) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'priceTooHigh') });
    }
    const renewalWholesaleEach = renewalWholesaleCents ?? wholesaleCents;
    const retailRenewalEach = retailFromWholesaleCents(renewalWholesaleEach);

    return {
      domainName,
      years,
      wholesaleCents,
      renewalWholesaleCents,
      wholesaleTotalCents: wholesaleCents + (years - 1) * renewalWholesaleEach,
      retailTotalCents: retailYear1 + (years - 1) * retailRenewalEach,
    };
  },

  async purchase(params: {
    organizationId: string;
    userId: string;
    domainName: string;
    years?: number;
    projectId?: string;
    locale: SupportedLocale;
  }) {
    const { organizationId, userId, projectId, locale } = params;
    const years = params.years ?? 1;
    const quote = await this.quote(params.domainName, years, locale);
    const { domainName, wholesaleTotalCents, retailTotalCents } = quote;
    const registrar = getRegistrar()!;

    // Charge first — registration only proceeds on a successful debit
    const balanceAfter = await infraBillingService.debitWallet(
      organizationId,
      retailTotalCents,
      'domain_purchase',
      `Domain purchase: ${domainName} (${years} ${years === 1 ? 'year' : 'years'})`,
      undefined,
      { domainName, years, wholesaleTotalCents }
    );
    if (balanceAfter === null) {
      throw new HTTPException(402, { message: t(locale, 'domains', 'insufficientCredits') });
    }

    let registered;
    try {
      registered = await registrar.register(domainName, {
        years,
        wholesaleCents: wholesaleTotalCents,
      });
    } catch (error) {
      logger.error({ err: error, domainName, organizationId }, 'Domain registration failed');
      await refundWallet(
        organizationId,
        retailTotalCents,
        `Refund: domain registration failed — ${domainName}`
      ).catch((refundErr) =>
        logger.error({ err: refundErr, domainName, organizationId }, 'Domain refund failed')
      );
      throw new HTTPException(502, { message: t(locale, 'domains', 'purchaseFailed') });
    }

    const expiresAt =
      registered.expiresAt ?? new Date(Date.now() + years * 365 * 24 * 60 * 60 * 1000);

    const [record] = await db
      .insert(purchasedDomains)
      .values({
        organizationId,
        projectId: projectId ?? null,
        domainName,
        registrar: registrar.id,
        years,
        purchasePriceCents: retailTotalCents,
        wholesalePriceCents: wholesaleTotalCents,
        renewalWholesaleCents: quote.renewalWholesaleCents,
        expiresAt,
      })
      .returning();

    // Best-effort attach: point DNS at the project's server and add the domain record.
    let attached = false;
    if (projectId) {
      attached = await this.attachToProject({
        organizationId,
        userId,
        projectId,
        domainName,
        locale,
      }).catch((error) => {
        logger.warn({ err: error, domainName, projectId }, 'Post-purchase attach failed');
        return false;
      });
    }

    adminNotify('domain.purchased', {
      organizationId,
      domain: domainName,
      years: String(years),
      retail: `$${(retailTotalCents / 100).toFixed(2)}`,
      wholesale: `$${(wholesaleTotalCents / 100).toFixed(2)}`,
      expires: expiresAt.toISOString().slice(0, 10),
    });

    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    const notifyEmail = await resolveBillingNotifyEmail(organizationId).catch(() => null);
    if (notifyEmail && org) {
      void sendDomainPurchasedEmail(
        notifyEmail,
        org.name,
        domainName,
        retailTotalCents,
        expiresAt,
        locale === 'tr' ? 'tr' : 'en'
      );
    }

    return { domain: record, balanceAfterCents: balanceAfter, attached };
  },

  /** Create A/www records at the registrar and register the domain on the project. */
  async attachToProject(params: {
    organizationId: string;
    userId: string;
    projectId: string;
    domainName: string;
    locale: SupportedLocale;
  }): Promise<boolean> {
    const { organizationId, userId, projectId, domainName, locale } = params;
    const registrar = getRegistrar();
    if (!registrar) return false;

    const [project] = await db
      .select({ id: projects.id, serverId: projects.serverId })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
      .limit(1);
    if (!project) return false;

    const serverId = resolveProjectServerId({ id: project.id, serverId: project.serverId });
    if (serverId) {
      const [server] = await db
        .select({ ipv4: servers.ipv4 })
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1);
      if (server?.ipv4) {
        await registrar.createDnsRecord(domainName, { host: '@', type: 'A', answer: server.ipv4 });
        await registrar
          .createDnsRecord(domainName, { host: 'www', type: 'CNAME', answer: domainName })
          .catch(() => undefined);
      }
    }

    await domainService.create(projectId, organizationId, userId, { domain: domainName }, locale);
    return true;
  },

  /**
   * Complete a card-paid domain purchase (from the Stripe Checkout webhook).
   * Credits the wallet with the paid amount (idempotent per checkout session id),
   * then runs the normal wallet purchase. If registration fails, the purchase path
   * refunds the debit — the paid amount stays in the customer's wallet instead of
   * being lost, and the operator is notified.
   */
  async fulfillCheckout(params: {
    sessionId: string;
    organizationId: string;
    userId: string;
    domainName: string;
    years: number;
    projectId?: string;
    locale: SupportedLocale;
    amountCents: number;
  }): Promise<{ fulfilled: boolean; alreadyProcessed: boolean }> {
    const { created } = await infraBillingService.creditWallet(
      params.organizationId,
      params.amountCents,
      `Domain purchase payment: ${params.domainName}`,
      params.sessionId
    );
    if (!created) {
      return { fulfilled: false, alreadyProcessed: true };
    }

    try {
      await this.purchase({
        organizationId: params.organizationId,
        userId: params.userId,
        domainName: params.domainName,
        years: params.years,
        projectId: params.projectId,
        locale: params.locale,
      });
      return { fulfilled: true, alreadyProcessed: false };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';
      logger.error(
        { err: error, domainName: params.domainName, organizationId: params.organizationId },
        'Domain checkout fulfillment failed — paid amount left as wallet credit'
      );
      adminNotify('payment.failed', {
        organizationId: params.organizationId,
        stage: 'domain_checkout_fulfillment',
        domain: params.domainName,
        reason: reason.slice(0, 200),
      });
      return { fulfilled: false, alreadyProcessed: false };
    }
  },

  async listByOrganization(organizationId: string) {
    return db
      .select()
      .from(purchasedDomains)
      .where(eq(purchasedDomains.organizationId, organizationId))
      .orderBy(purchasedDomains.createdAt);
  },

  async setAutoRenew(
    organizationId: string,
    domainName: string,
    enabled: boolean,
    locale: SupportedLocale
  ) {
    const [updated] = await db
      .update(purchasedDomains)
      .set({ autoRenew: enabled, updatedAt: new Date() })
      .where(
        and(
          eq(purchasedDomains.organizationId, organizationId),
          eq(purchasedDomains.domainName, domainName)
        )
      )
      .returning();
    if (!updated) {
      throw new HTTPException(404, { message: t(locale, 'domains', 'purchasedNotFound') });
    }
    return updated;
  },

  /** Ownership guard for management operations on a purchased domain. */
  async requireOwnedDomain(
    organizationId: string,
    domainNameRaw: string,
    locale: SupportedLocale,
    opts?: { activeOnly?: boolean }
  ) {
    if (!getRegistrar()) {
      throw new HTTPException(503, { message: t(locale, 'domains', 'registrarNotConfigured') });
    }
    const domainName = normalizeKeyword(domainNameRaw);
    const [row] = await db
      .select()
      .from(purchasedDomains)
      .where(
        and(
          eq(purchasedDomains.organizationId, organizationId),
          eq(purchasedDomains.domainName, domainName)
        )
      )
      .limit(1);
    if (!row) {
      throw new HTTPException(404, { message: t(locale, 'domains', 'purchasedNotFound') });
    }
    if ((opts?.activeOnly ?? true) && row.status !== 'active') {
      throw new HTTPException(409, { message: t(locale, 'domains', 'notActiveDomain') });
    }
    return row;
  },

  // ── DNS management ──

  async listDnsRecords(organizationId: string, domainName: string, locale: SupportedLocale) {
    const row = await this.requireOwnedDomain(organizationId, domainName, locale);
    return getRegistrar()!.listDnsRecords(row.domainName);
  },

  async createDnsRecord(
    organizationId: string,
    domainName: string,
    input: Record<string, unknown>,
    locale: SupportedLocale
  ) {
    const row = await this.requireOwnedDomain(organizationId, domainName, locale);
    const record = validateDnsInput(input);
    if (!record) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'dnsRecordInvalid') });
    }
    return getRegistrar()!.createDnsRecord(row.domainName, record);
  },

  async updateDnsRecord(
    organizationId: string,
    domainName: string,
    recordId: string,
    input: Record<string, unknown>,
    locale: SupportedLocale
  ) {
    const row = await this.requireOwnedDomain(organizationId, domainName, locale);
    const record = validateDnsInput(input);
    if (!record) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'dnsRecordInvalid') });
    }
    return getRegistrar()!.updateDnsRecord(row.domainName, recordId, record);
  },

  async deleteDnsRecord(
    organizationId: string,
    domainName: string,
    recordId: string,
    locale: SupportedLocale
  ) {
    const row = await this.requireOwnedDomain(organizationId, domainName, locale);
    await getRegistrar()!.deleteDnsRecord(row.domainName, recordId);
  },

  // ── Domain settings ──

  async getDomainDetails(organizationId: string, domainName: string, locale: SupportedLocale) {
    const row = await this.requireOwnedDomain(organizationId, domainName, locale, {
      activeOnly: false,
    });
    const info =
      row.status === 'active'
        ? await getRegistrar()!
            .getDomainInfo(row.domainName)
            .catch(() => null)
        : null;
    return {
      domain: row,
      locked: info?.locked ?? null,
      nameservers: info?.nameservers ?? [],
    };
  },

  async setLock(
    organizationId: string,
    domainName: string,
    locked: boolean,
    locale: SupportedLocale
  ) {
    const row = await this.requireOwnedDomain(organizationId, domainName, locale);
    await getRegistrar()!.setLock(row.domainName, locked);
    return { locked };
  },

  async setNameservers(
    organizationId: string,
    domainName: string,
    nameservers: unknown,
    locale: SupportedLocale
  ) {
    const row = await this.requireOwnedDomain(organizationId, domainName, locale);
    const list = Array.isArray(nameservers)
      ? nameservers.map((n) => String(n).trim().toLowerCase()).filter(Boolean)
      : [];
    if (list.length < 2 || list.length > 6 || list.some((n) => !NAMESERVER_PATTERN.test(n))) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'nameserversInvalid') });
    }
    await getRegistrar()!.setNameservers(row.domainName, list);
    return { nameservers: list };
  },

  // ── Transfer-out ──

  /** Unlocks the domain and returns its EPP/auth code (ICANN transfer-out right). */
  async getTransferOutAuthCode(
    organizationId: string,
    domainName: string,
    locale: SupportedLocale
  ) {
    const row = await this.requireOwnedDomain(organizationId, domainName, locale);
    const registrar = getRegistrar()!;
    await registrar.setLock(row.domainName, false).catch(() => undefined);
    const authCode = await registrar.getAuthCode(row.domainName);

    adminNotify('domain.authcode_viewed', {
      organizationId,
      domain: row.domainName,
    });
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    const notifyEmail = await resolveBillingNotifyEmail(organizationId).catch(() => null);
    if (notifyEmail && org) {
      void sendDomainAuthCodeViewedEmail(
        notifyEmail,
        org.name,
        row.domainName,
        locale === 'tr' ? 'tr' : 'en'
      );
    }
    return { authCode };
  },

  // ── Transfer-in ──

  /**
   * Price a transfer-in. A transfer includes a 1-year renewal, so it's priced at the
   * TLD's renewal rate — probed via a synthetic availability check on the same TLD
   * (the registrar exposes per-domain pricing only through availability lookups).
   */
  async getTransferQuote(domainNameRaw: string, locale: SupportedLocale) {
    const registrar = getRegistrar();
    if (!registrar) {
      throw new HTTPException(503, { message: t(locale, 'domains', 'registrarNotConfigured') });
    }
    const domainName = normalizeKeyword(domainNameRaw);
    if (!DOMAIN_REGEX.test(domainName)) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
    }

    const [existing] = await db
      .select({ id: purchasedDomains.id })
      .from(purchasedDomains)
      .where(eq(purchasedDomains.domainName, domainName))
      .limit(1);
    if (existing) {
      throw new HTTPException(409, { message: t(locale, 'domains', 'alreadyExists') });
    }

    const tld = domainName.split('.').slice(1).join('.');
    const probeName = `pushify-price-probe-${Date.now()}.${tld}`;
    const [own, probe] = await registrar.checkAvailability([domainName, probeName]);
    if (own?.available) {
      // Not registered anywhere — nothing to transfer; it can simply be bought
      throw new HTTPException(400, { message: t(locale, 'domains', 'transferNotRegistered') });
    }
    const wholesaleCents = probe?.renewalWholesaleCents ?? probe?.wholesaleCents ?? null;
    if (!probe?.available || !wholesaleCents) {
      throw new HTTPException(502, { message: t(locale, 'domains', 'transferPriceUnknown') });
    }
    const retailCents = retailFromWholesaleCents(wholesaleCents);
    if (retailCents > domainMaxPriceCents()) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'priceTooHigh') });
    }
    return { domainName, wholesaleCents, retailCents };
  },

  async startTransfer(params: {
    organizationId: string;
    userId: string;
    domainName: string;
    authCode: string;
    locale: SupportedLocale;
  }) {
    const { organizationId, locale } = params;
    const quote = await this.getTransferQuote(params.domainName, locale);
    const registrar = getRegistrar()!;
    const authCode = params.authCode.trim();
    if (!authCode || authCode.length > 255) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'authCodeRequired') });
    }

    const balanceAfter = await infraBillingService.debitWallet(
      organizationId,
      quote.retailCents,
      'domain_purchase',
      `Domain transfer: ${quote.domainName}`,
      undefined,
      { domainName: quote.domainName, kind: 'transfer', wholesaleCents: quote.wholesaleCents }
    );
    if (balanceAfter === null) {
      throw new HTTPException(402, { message: t(locale, 'domains', 'insufficientCredits') });
    }

    try {
      await registrar.createTransfer(quote.domainName, {
        authCode,
        wholesaleCents: quote.wholesaleCents,
      });
    } catch (error) {
      logger.error({ err: error, domainName: quote.domainName }, 'Domain transfer start failed');
      await refundWallet(
        organizationId,
        quote.retailCents,
        `Refund: domain transfer failed to start — ${quote.domainName}`
      ).catch((refundErr) =>
        logger.error({ err: refundErr, domainName: quote.domainName }, 'Transfer refund failed')
      );
      throw new HTTPException(502, { message: t(locale, 'domains', 'transferStartFailed') });
    }

    const [record] = await db
      .insert(purchasedDomains)
      .values({
        organizationId,
        domainName: quote.domainName,
        registrar: registrar.id,
        status: 'transfer_pending',
        years: 1,
        purchasePriceCents: quote.retailCents,
        wholesalePriceCents: quote.wholesaleCents,
        renewalWholesaleCents: quote.wholesaleCents,
        // Real expiry lands when the transfer completes (existing expiry + 1 year)
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      })
      .returning();

    adminNotify('domain.transfer_started', {
      organizationId,
      domain: quote.domainName,
      retail: `$${(quote.retailCents / 100).toFixed(2)}`,
    });
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    const notifyEmail = await resolveBillingNotifyEmail(organizationId).catch(() => null);
    if (notifyEmail && org) {
      void sendDomainTransferStartedEmail(
        notifyEmail,
        org.name,
        quote.domainName,
        quote.retailCents,
        locale === 'tr' ? 'tr' : 'en'
      );
    }
    return { domain: record, balanceAfterCents: balanceAfter };
  },

  // ── Email forwarding ──

  async listEmailForwardings(organizationId: string, domainName: string, locale: SupportedLocale) {
    const row = await this.requireOwnedDomain(organizationId, domainName, locale);
    return getRegistrar()!.listEmailForwardings(row.domainName);
  },

  async addEmailForwarding(
    organizationId: string,
    domainName: string,
    input: { emailBox?: unknown; emailTo?: unknown },
    locale: SupportedLocale
  ) {
    const row = await this.requireOwnedDomain(organizationId, domainName, locale);
    const emailBox = typeof input.emailBox === 'string' ? input.emailBox.trim() : '';
    const emailTo = typeof input.emailTo === 'string' ? input.emailTo.trim() : '';
    if (!EMAIL_BOX_PATTERN.test(emailBox) || !EMAIL_PATTERN.test(emailTo)) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'forwardingInvalid') });
    }
    await getRegistrar()!.createEmailForwarding(row.domainName, { emailBox, emailTo });
    return { emailBox, emailTo };
  },

  async deleteEmailForwarding(
    organizationId: string,
    domainName: string,
    emailBox: string,
    locale: SupportedLocale
  ) {
    const row = await this.requireOwnedDomain(organizationId, domainName, locale);
    if (!EMAIL_BOX_PATTERN.test(emailBox)) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'forwardingInvalid') });
    }
    await getRegistrar()!.deleteEmailForwarding(row.domainName, emailBox);
  },
};

export { refundWallet as refundDomainCharge };
