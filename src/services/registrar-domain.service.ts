import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { infraWalletTransactions, organizations, projects, purchasedDomains, servers } from '../db/schema';
import { getRegistrar } from '../lib/registrar';
import {
  domainMarginPercent,
  domainMaxPriceCents,
  retailFromWholesaleCents,
} from '../lib/domain-pricing';
import { resolveProjectServerId } from '../lib/runner-routing';
import { resolveBillingNotifyEmail } from '../lib/billing-notify';
import { sendDomainPurchasedEmail } from '../lib/email';
import { logger } from '../lib/logger';
import { adminNotify } from './admin-notify.service';
import { infraBillingService } from './infra-billing.service';
import { domainService } from './domain.service';
import { t, type SupportedLocale } from '../i18n';

const DOMAIN_REGEX =
  /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** TLDs offered in keyword search (one availability call covers all of them). */
const SEARCH_TLDS = ['com', 'net', 'org', 'dev', 'app', 'io', 'co', 'me', 'xyz', 'ai'];

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

  async purchase(params: {
    organizationId: string;
    userId: string;
    domainName: string;
    projectId?: string;
    locale: SupportedLocale;
  }) {
    const { organizationId, userId, projectId, locale } = params;
    const registrar = getRegistrar();
    if (!registrar) {
      throw new HTTPException(503, { message: t(locale, 'domains', 'registrarNotConfigured') });
    }

    const domainName = normalizeKeyword(params.domainName);
    if (!DOMAIN_REGEX.test(domainName)) {
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

    // Re-check availability at purchase time — search results may be stale
    const [availability] = await registrar.checkAvailability([domainName]);
    if (!availability?.available || !availability.wholesaleCents) {
      throw new HTTPException(409, { message: t(locale, 'domains', 'notAvailable') });
    }
    if (availability.premium) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'premiumNotSupported') });
    }

    const years = 1;
    const wholesaleCents = availability.wholesaleCents;
    const retailCents = retailFromWholesaleCents(wholesaleCents);
    if (retailCents > domainMaxPriceCents()) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'priceTooHigh') });
    }

    // Charge first — registration only proceeds on a successful debit
    const balanceAfter = await infraBillingService.debitWallet(
      organizationId,
      retailCents,
      'domain_purchase',
      `Domain purchase: ${domainName} (${years} year)`,
      undefined,
      { domainName, wholesaleCents }
    );
    if (balanceAfter === null) {
      throw new HTTPException(402, { message: t(locale, 'domains', 'insufficientCredits') });
    }

    let registered;
    try {
      registered = await registrar.register(domainName, { years, wholesaleCents });
    } catch (error) {
      logger.error({ err: error, domainName, organizationId }, 'Domain registration failed');
      await refundWallet(
        organizationId,
        retailCents,
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
        purchasePriceCents: retailCents,
        wholesalePriceCents: wholesaleCents,
        renewalWholesaleCents: availability.renewalWholesaleCents,
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
      retail: `$${(retailCents / 100).toFixed(2)}`,
      wholesale: `$${(wholesaleCents / 100).toFixed(2)}`,
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
        retailCents,
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
};

export { refundWallet as refundDomainCharge };
