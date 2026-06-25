import { HTTPException } from 'hono/http-exception';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { db } from '../db';
import { organizations, infraWalletTransactions } from '../db/schema';
import { servers } from '../db/schema/servers';
import { createProvider, type ProviderType } from '../providers';
import type { ServerSize } from '../providers/cloud-provider.interface';
import { organizationRepository } from '../repositories/organization.repository';
import { t, type SupportedLocale } from '../i18n';
import {
  applyInfraMargin,
  assertServerWithinPlanLimits,
  buildPriceQuote,
  eurToUsdCents,
  getPlanInfraLimits,
  minimumWalletBalanceForQuote,
  INFRA_MARGIN_PERCENT,
  INFRA_TOPUP_AMOUNTS_CENTS,
  INFRA_LOW_BALANCE_WARN_CENTS,
  type InfraPriceQuote,
} from '../lib/infra-billing';
import { resolveBillingNotifyEmail } from '../lib/billing-notify';
import {
  sendInfraCreditsLowEmail,
  sendInfraServerSuspendedEmail,
} from '../lib/email';
import { getIncludedInfraCreditCents, type PlanType } from '../lib/plans';
import { logger } from '../lib/logger';

function getProviderToken(provider: ProviderType): string {
  switch (provider) {
    case 'hetzner':
      return process.env.HETZNER_API_TOKEN || '';
    default:
      return '';
  }
}

/**
 * Headroom multiplier applied to the cheapest server's current monthly price when sizing
 * the included compute credit, so FX/price drift between the grant and the customer's
 * "start server" click can't leave them just short of the start threshold.
 */
const INFRA_INCLUDED_CREDIT_HEADROOM = 1.08;

function mapInfraError(code: string, locale: SupportedLocale): string {
  const keyMap: Record<string, string> = {
    PLAN_NO_MANAGED_SERVERS: 'managedNotAllowed',
    PLAN_SERVER_VCPU_EXCEEDED: 'serverTierExceeded',
    PLAN_SERVER_MEMORY_EXCEEDED: 'serverTierExceeded',
    PLAN_SERVER_PRICE_EXCEEDED: 'serverTierExceeded',
    INSUFFICIENT_WALLET: 'insufficientWallet',
  };
  const key = keyMap[code] || 'billingError';
  return t(locale, 'infraBilling', key as 'insufficientWallet');
}

export interface InfraWalletSummary {
  balanceCents: number;
  balanceUsd: string;
  marginPercent: number;
  estimatedMonthlyBurnCents: number;
  runningManagedServers: number;
  topUpAmountsCents: readonly number[];
  /** True when balance is below warn threshold or below ~1 month of running-server burn */
  isLowBalance: boolean;
  /** Estimated days until wallet empty at current burn (null if no burn) */
  runwayDays: number | null;
}

export interface ServerInfraBillingContext {
  walletBalanceCents: number;
  requiredStartCents: number;
  estimatedMonthlyCents: number;
  canStart: boolean;
}

export interface SizedOptionForPlan {
  size: ServerSize;
  specs: {
    vcpus: number;
    memoryMb: number;
    diskGb: number;
    providerCostMonthlyCents: number;
    providerCostHourlyCents: number;
    customerPriceMonthlyCents: number;
    customerPriceHourlyCents: number;
    marginPercent: number;
  };
  allowedByPlan: boolean;
  /** Stable code for clients to localize UI (prefer over disallowReason). */
  disallowCode?: 'managedNotAllowed' | 'serverTierExceeded';
  disallowReason?: string;
}

export const infraBillingService = {
  async getServerInfraBillingContext(
    organizationId: string,
    serverId: string,
  ): Promise<ServerInfraBillingContext | null> {
    const [server] = await db
      .select({
        isManaged: servers.isManaged,
        provider: servers.provider,
        customerPriceMonthlyCents: servers.customerPriceMonthlyCents,
      })
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!server?.isManaged || server.provider === 'self_hosted') {
      return null;
    }

    const org = await organizationRepository.findById(organizationId);
    if (!org) return null;

    let monthly = server.customerPriceMonthlyCents ?? 0;
    if (monthly <= 0) {
      await this.backfillServerBillingIfMissing(serverId);
      const [refreshed] = await db
        .select({ monthly: servers.customerPriceMonthlyCents })
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1);
      monthly = refreshed?.monthly ?? 0;
    }

    const balance = org.infraWalletBalanceCents ?? 0;
    const requiredStartCents = org.plan === 'enterprise' ? 0 : monthly;

    return {
      walletBalanceCents: balance,
      requiredStartCents,
      estimatedMonthlyCents: monthly,
      canStart: org.plan === 'enterprise' || balance >= requiredStartCents,
    };
  },

  async getWalletSummary(organizationId: string): Promise<InfraWalletSummary> {
    const [org] = await db
      .select({
        balance: organizations.infraWalletBalanceCents,
        plan: organizations.plan,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    const balanceCents = org?.balance ?? 0;
    const plan = (org?.plan || 'free') as PlanType;

    const running = await db
      .select({
        customerHourly: servers.customerPriceHourlyCents,
      })
      .from(servers)
      .where(
        and(
          eq(servers.organizationId, organizationId),
          eq(servers.isManaged, true),
          inArray(servers.status, ['running', 'rebooting']),
        ),
      );

    const estimatedMonthlyBurnCents = running.reduce((sum, s) => {
      const hourly = s.customerHourly ?? 0;
      return sum + hourly * 730;
    }, 0);

    const isLowBalance =
      plan !== 'enterprise' &&
      (balanceCents < INFRA_LOW_BALANCE_WARN_CENTS ||
        (estimatedMonthlyBurnCents > 0 && balanceCents < estimatedMonthlyBurnCents));

    const runwayDays =
      estimatedMonthlyBurnCents > 0
        ? Math.floor((balanceCents / estimatedMonthlyBurnCents) * 30)
        : null;

    return {
      balanceCents,
      balanceUsd: (balanceCents / 100).toFixed(2),
      marginPercent: INFRA_MARGIN_PERCENT,
      estimatedMonthlyBurnCents,
      runningManagedServers: running.length,
      topUpAmountsCents: INFRA_TOPUP_AMOUNTS_CENTS,
      isLowBalance,
      runwayDays,
    };
  },

  async getSizedOptionsForOrganization(
    organizationId: string,
    plan: PlanType,
    provider: ProviderType,
    region: string,
    locale: SupportedLocale,
  ): Promise<SizedOptionForPlan[]> {
    const apiToken = getProviderToken(provider);
    if (!apiToken) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'providerNotConfigured') });
    }

    const providerInstance = createProvider(provider, apiToken);
    const sizes = await providerInstance.listSizes();
    const limits = getPlanInfraLimits(plan);

    return sizes.map((entry) => {
      const quote = buildPriceQuote(
        entry.specs.priceMonthly,
        entry.specs.priceMonthly / 730,
        {
          vcpus: entry.specs.vcpus,
          memoryMb: entry.specs.memoryMb,
          diskGb: entry.specs.diskGb,
        },
      );

      let allowedByPlan = limits.managedServersEnabled;
      let disallowCode: SizedOptionForPlan['disallowCode'];
      let disallowReason: string | undefined;

      if (allowedByPlan) {
        try {
          assertServerWithinPlanLimits(plan, quote.specs, quote.providerCostMonthlyCents);
        } catch (e) {
          allowedByPlan = false;
          disallowCode = 'serverTierExceeded';
          disallowReason =
            e instanceof Error ? mapInfraError(e.message, locale) : undefined;
        }
      } else {
        disallowCode = 'managedNotAllowed';
        disallowReason = t(locale, 'infraBilling', 'managedNotAllowed');
      }

      return {
        size: entry.size,
        specs: {
          vcpus: quote.specs.vcpus,
          memoryMb: quote.specs.memoryMb,
          diskGb: quote.specs.diskGb,
          providerCostMonthlyCents: quote.providerCostMonthlyCents,
          providerCostHourlyCents: quote.providerCostHourlyCents,
          customerPriceMonthlyCents: quote.customerPriceMonthlyCents,
          customerPriceHourlyCents: quote.customerPriceHourlyCents,
          marginPercent: quote.marginPercent,
        },
        allowedByPlan,
        disallowCode,
        disallowReason,
      };
    });
  },

  async quoteManagedServer(
    plan: PlanType,
    provider: ProviderType,
    region: string,
    size: ServerSize,
    locale: SupportedLocale,
  ): Promise<InfraPriceQuote> {
    const apiToken = getProviderToken(provider);
    if (!apiToken) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'providerNotConfigured') });
    }

    const providerInstance = createProvider(provider, apiToken);
    const sizes = await providerInstance.listSizes();
    const match = sizes.find((s) => s.size === size);
    if (!match) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'createFailed') });
    }

    const quote = buildPriceQuote(
      match.specs.priceMonthly,
      match.specs.priceMonthly / 730,
      {
        vcpus: match.specs.vcpus,
        memoryMb: match.specs.memoryMb,
        diskGb: match.specs.diskGb,
      },
    );

    try {
      assertServerWithinPlanLimits(plan, quote.specs, quote.providerCostMonthlyCents);
    } catch (e) {
      const code = e instanceof Error ? e.message : 'PLAN_SERVER_PRICE_EXCEEDED';
      throw new HTTPException(403, { message: mapInfraError(code, locale) });
    }

    return quote;
  },

  async assertWalletCanProvision(
    organizationId: string,
    plan: PlanType,
    quote: InfraPriceQuote,
    locale: SupportedLocale,
  ): Promise<void> {
    if (plan === 'enterprise') {
      return;
    }

    const [org] = await db
      .select({ balance: organizations.infraWalletBalanceCents })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    const required = minimumWalletBalanceForQuote(quote);
    const balance = org?.balance ?? 0;

    if (balance < required) {
      throw new HTTPException(402, {
        message: t(locale, 'infraBilling', 'insufficientWallet'),
      });
    }
  },

  async creditWallet(
    organizationId: string,
    amountCents: number,
    description: string,
    stripeCheckoutSessionId?: string,
  ): Promise<{ balanceAfterCents: number; created: boolean }> {
    if (amountCents <= 0) {
      throw new Error('Credit amount must be positive');
    }

    if (stripeCheckoutSessionId) {
      const [existing] = await db
        .select({ balanceAfterCents: infraWalletTransactions.balanceAfterCents })
        .from(infraWalletTransactions)
        .where(
          and(
            eq(infraWalletTransactions.organizationId, organizationId),
            eq(infraWalletTransactions.stripeCheckoutSessionId, stripeCheckoutSessionId),
          ),
        )
        .limit(1);

      if (existing) {
        await this.clearInfraCreditsStoppedMessages(organizationId);
        return { balanceAfterCents: existing.balanceAfterCents, created: false };
      }
    }

    const balanceAfterCents = await db.transaction(async (tx) => {
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
        type: 'credit_topup',
        amountCents,
        balanceAfterCents: newBalance,
        description,
        stripeCheckoutSessionId: stripeCheckoutSessionId ?? null,
      });

      return newBalance;
    });

    await this.clearInfraCreditsStoppedMessages(organizationId);

    return { balanceAfterCents, created: true };
  },

  /**
   * Remove stale "infra credits stopped" copy when the wallet can fund a start again.
   * Does not power servers on — users still tap Start after topping up.
   */
  async clearInfraCreditsStoppedMessages(organizationId: string): Promise<number> {
    const org = await organizationRepository.findById(organizationId);
    if (!org) return 0;

    const balance = org.infraWalletBalanceCents ?? 0;
    if (org.plan === 'enterprise') {
      const cleared = await db
        .update(servers)
        .set({ statusMessage: null, updatedAt: new Date() })
        .where(
          and(
            eq(servers.organizationId, organizationId),
            eq(servers.statusMessage, 'infra_credits_stopped'),
          ),
        )
        .returning({ id: servers.id });
      return cleared.length;
    }

    const candidates = await db
      .select()
      .from(servers)
      .where(
        and(
          eq(servers.organizationId, organizationId),
          eq(servers.statusMessage, 'infra_credits_stopped'),
        ),
      );

    let count = 0;
    for (const server of candidates) {
      let monthly = server.customerPriceMonthlyCents ?? 0;
      if (monthly <= 0) {
        await this.backfillServerBillingIfMissing(server.id);
        const [refreshed] = await db
          .select({ monthly: servers.customerPriceMonthlyCents })
          .from(servers)
          .where(eq(servers.id, server.id))
          .limit(1);
        monthly = refreshed?.monthly ?? 0;
      }

      if (monthly > 0 && balance < monthly) {
        continue;
      }

      await db
        .update(servers)
        .set({ statusMessage: null, updatedAt: new Date() })
        .where(eq(servers.id, server.id));
      count++;
    }

    return count;
  },

  async debitWallet(
    organizationId: string,
    amountCents: number,
    type: 'server_hourly_charge' | 'adjustment',
    description: string,
    serverId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<number | null> {
    if (amountCents <= 0) {
      throw new Error('Debit amount must be positive');
    }

    return db.transaction(async (tx) => {
      const [org] = await tx
        .select({ balance: organizations.infraWalletBalanceCents, plan: organizations.plan })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);

      if (org?.plan === 'enterprise') {
        return org.balance ?? 0;
      }

      const current = org?.balance ?? 0;
      if (current < amountCents) {
        return null;
      }

      const newBalance = current - amountCents;

      await tx
        .update(organizations)
        .set({ infraWalletBalanceCents: newBalance, updatedAt: new Date() })
        .where(eq(organizations.id, organizationId));

      await tx.insert(infraWalletTransactions).values({
        organizationId,
        serverId: serverId ?? null,
        type,
        amountCents: -amountCents,
        balanceAfterCents: newBalance,
        description,
        metadata: metadata ?? {},
      });

      return newBalance;
    });
  },

  /**
   * Grant the plan's included compute credit by topping the infra wallet UP to the plan
   * allowance (never above). Called on each paid invoice so a paying customer can run their
   * entry server without a separate top-up.
   *
   * Safe by construction:
   * - Never over-credits: if the wallet already holds >= the allowance (e.g. the customer
   *   topped up cash), nothing is added.
   * - Naturally idempotent: re-processing the same invoice finds the balance already at the
   *   allowance and grants 0.
   * - Loss is bounded: the allowance is below each plan's net margin, and the existing
   *   "balance hits 0 → suspend server" backstop caps provider spend at what was funded.
   * Free/enterprise (allowance 0) are no-ops.
   */
  /**
   * Cheapest plan-eligible managed server's CURRENT monthly customer price (USD cents),
   * priced live off Hetzner + the dynamic FX rate. Returns 0 if it can't be determined
   * (no provider token / API error), so callers fall back to the plan ceiling.
   */
  async getCheapestEligibleMonthlyCents(plan: PlanType): Promise<number> {
    const token = getProviderToken('hetzner');
    if (!token) return 0;

    const provider = createProvider('hetzner', token);
    const sizes = await provider.listSizes();

    let cheapest = 0;
    for (const entry of sizes) {
      const quote = buildPriceQuote(entry.specs.priceMonthly, entry.specs.priceMonthly / 730, {
        vcpus: entry.specs.vcpus,
        memoryMb: entry.specs.memoryMb,
        diskGb: entry.specs.diskGb,
      });
      try {
        // Same gate the UI/provisioning uses — vcpu, memory, and provider $ cap.
        assertServerWithinPlanLimits(plan, quote.specs, quote.providerCostMonthlyCents);
      } catch {
        continue; // not startable on this plan
      }
      if (cheapest === 0 || quote.customerPriceMonthlyCents < cheapest) {
        cheapest = quote.customerPriceMonthlyCents;
      }
    }
    return cheapest;
  },

  /**
   * Target balance the included credit should top the wallet up to: enough to start the
   * cheapest eligible server at current prices (+ headroom), capped at the plan ceiling so
   * margin stays bounded. Falls back to the ceiling if the live price can't be determined.
   */
  async computeIncludedCreditTargetCents(plan: PlanType): Promise<number> {
    const ceilingCents = getIncludedInfraCreditCents(plan);
    if (ceilingCents <= 0) return 0;

    try {
      const cheapest = await this.getCheapestEligibleMonthlyCents(plan);
      if (cheapest > 0) {
        const withHeadroom = Math.ceil(cheapest * INFRA_INCLUDED_CREDIT_HEADROOM);
        if (withHeadroom > ceilingCents) {
          logger.warn(
            { plan, cheapestMonthlyCents: cheapest, ceilingCents },
            'Included credit: cheapest server exceeds plan ceiling — entry server may not start, review plan economics',
          );
          return ceilingCents;
        }
        return withHeadroom;
      }
    } catch (err) {
      logger.warn(
        { plan, err: err instanceof Error ? err.message : String(err) },
        'Included credit: cheapest-server lookup failed, falling back to plan ceiling',
      );
    }
    return ceilingCents;
  },

  /**
   * Grant the plan's included compute credit by topping the infra wallet UP to a target
   * that covers the cheapest eligible server at CURRENT prices (see
   * computeIncludedCreditTargetCents). Called on each paid invoice so a paying customer can
   * start their entry server without a separate top-up.
   *
   * Safe by construction:
   * - Never over-credits: if the wallet already holds >= the target, nothing is added.
   * - Naturally idempotent: re-processing the same invoice grants 0.
   * - Loss is bounded: the target is capped at the plan ceiling (< plan net margin), and the
   *   existing "balance hits 0 → suspend server" backstop caps provider spend at what was funded.
   * Pass { dryRun } to compute what WOULD be granted without writing.
   */
  async grantIncludedInfraCredit(
    organizationId: string,
    plan: PlanType,
    opts?: { dryRun?: boolean },
  ): Promise<{ grantedCents: number; balanceAfterCents: number; targetCents: number }> {
    const targetCents = await this.computeIncludedCreditTargetCents(plan);

    if (targetCents <= 0) {
      const [org] = await db
        .select({ balance: organizations.infraWalletBalanceCents })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);
      return { grantedCents: 0, balanceAfterCents: org?.balance ?? 0, targetCents: 0 };
    }

    if (opts?.dryRun) {
      const [org] = await db
        .select({ balance: organizations.infraWalletBalanceCents })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);
      const current = org?.balance ?? 0;
      const grantedCents = Math.max(0, targetCents - current);
      return { grantedCents, balanceAfterCents: current + grantedCents, targetCents };
    }

    const result = await db.transaction(async (tx) => {
      const [org] = await tx
        .select({ balance: organizations.infraWalletBalanceCents })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);

      const current = org?.balance ?? 0;
      const grantedCents = Math.max(0, targetCents - current);

      if (grantedCents <= 0) {
        return { grantedCents: 0, balanceAfterCents: current };
      }

      const balanceAfterCents = current + grantedCents;

      await tx
        .update(organizations)
        .set({ infraWalletBalanceCents: balanceAfterCents, updatedAt: new Date() })
        .where(eq(organizations.id, organizationId));

      await tx.insert(infraWalletTransactions).values({
        organizationId,
        type: 'credit_topup',
        amountCents: grantedCents,
        balanceAfterCents,
        description: `Included ${plan} plan compute credit`,
        metadata: { bundled: true, plan, targetCents },
      });

      return { grantedCents, balanceAfterCents };
    });

    if (result.grantedCents > 0) {
      // A server stopped for low balance can be started again now that credit is available.
      await this.clearInfraCreditsStoppedMessages(organizationId);
    }

    return { ...result, targetCents };
  },

  async refundWallet(
    organizationId: string,
    amountCents: number,
    description: string,
    serverId?: string,
  ): Promise<number> {
    return db.transaction(async (tx) => {
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
        serverId: serverId ?? null,
        type: 'server_refund',
        amountCents,
        balanceAfterCents: newBalance,
        description,
      });

      return newBalance;
    });
  },

  async listTransactions(organizationId: string, limit = 50) {
    return db
      .select()
      .from(infraWalletTransactions)
      .where(eq(infraWalletTransactions.organizationId, organizationId))
      .orderBy(desc(infraWalletTransactions.createdAt))
      .limit(limit);
  },

  /**
   * Backfill billing columns for legacy managed servers created before infra billing.
   */
  async backfillServerBillingIfMissing(serverId: string): Promise<void> {
    const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!server?.isManaged || server.provider === 'self_hosted') return;
    if (server.customerPriceHourlyCents && server.customerPriceHourlyCents > 0) return;

    const org = await organizationRepository.findById(server.organizationId);
    if (!org) return;

    const plan = (org.plan || 'free') as PlanType;
    try {
      const quote = await this.quoteManagedServer(
        plan,
        server.provider as ProviderType,
        server.region,
        server.size as ServerSize,
        'en',
      );
      const providerType =
        server.providerData &&
        typeof server.providerData === 'object' &&
        'serverType' in server.providerData &&
        server.providerData.serverType &&
        typeof server.providerData.serverType === 'object' &&
        'name' in server.providerData.serverType
          ? String((server.providerData.serverType as { name: string }).name)
          : undefined;

      await db
        .update(servers)
        .set({
          ...this.billingFieldsFromQuote(quote, providerType),
          updatedAt: new Date(),
        })
        .where(eq(servers.id, serverId));
    } catch (err) {
      logger.warn({ err, serverId }, 'Failed to backfill server infra billing fields');
    }
  },

  /**
   * Stop a managed server at the provider when infra credits are exhausted.
   */
  async suspendManagedServerForBilling(serverId: string, organizationId: string): Promise<boolean> {
    const [server] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!server?.isManaged || !server.providerId || server.provider === 'self_hosted') {
      return false;
    }

    const apiToken = getProviderToken(server.provider as ProviderType);
    if (!apiToken) return false;

    try {
      const provider = createProvider(server.provider as ProviderType, apiToken);
      await provider.powerOff(server.providerId);

      await db
        .update(servers)
        .set({
          status: 'stopped',
          statusMessage: 'infra_credits_stopped',
          updatedAt: new Date(),
        })
        .where(eq(servers.id, serverId));

      logger.info({ serverId, organizationId }, 'Managed server stopped due to insufficient infra credits');

      const org = await organizationRepository.findById(organizationId);
      const notifyEmail = await resolveBillingNotifyEmail(organizationId);
      if (notifyEmail && org) {
        await sendInfraServerSuspendedEmail(notifyEmail, org.name, server.name, 'en');
      }

      return true;
    } catch (err) {
      logger.error({ err, serverId }, 'Failed to stop server for insufficient infra credits');
      return false;
    }
  },

  /**
   * Hourly billing for running managed servers. Stops servers when wallet is empty.
   */
  async processHourlyBilling(): Promise<{ charged: number; stopped: number; skipped: number }> {
    const rows = await db
      .select()
      .from(servers)
      .where(
        and(
          eq(servers.isManaged, true),
          eq(servers.provider, 'hetzner'),
          inArray(servers.status, ['running', 'rebooting']),
        ),
      );

    let charged = 0;
    let stopped = 0;
    let skipped = 0;
    const minMsBetweenCharges = 50 * 60 * 1000;

    for (const server of rows) {
      if (!server.customerPriceHourlyCents || server.customerPriceHourlyCents <= 0) {
        await this.backfillServerBillingIfMissing(server.id);
        skipped++;
        continue;
      }

      if (
        server.infraLastChargedAt &&
        Date.now() - server.infraLastChargedAt.getTime() < minMsBetweenCharges
      ) {
        skipped++;
        continue;
      }

      const org = await organizationRepository.findById(server.organizationId);
      const plan = (org?.plan || 'free') as PlanType;

      if (plan === 'enterprise') {
        await db
          .update(servers)
          .set({ infraLastChargedAt: new Date(), updatedAt: new Date() })
          .where(eq(servers.id, server.id));
        skipped++;
        continue;
      }

      const hourly = server.customerPriceHourlyCents;
      const balanceBefore = org?.infraWalletBalanceCents ?? 0;

      const newBalance = await this.debitWallet(
        server.organizationId,
        hourly,
        'server_hourly_charge',
        `Hourly infra: ${server.name}`,
        server.id,
        { hourlyCents: hourly },
      );

      if (newBalance === null) {
        const didStop = await this.suspendManagedServerForBilling(server.id, server.organizationId);
        if (didStop) stopped++;
        continue;
      }

      if (
        newBalance < INFRA_LOW_BALANCE_WARN_CENTS &&
        balanceBefore >= INFRA_LOW_BALANCE_WARN_CENTS &&
        org
      ) {
        const notifyEmail = await resolveBillingNotifyEmail(server.organizationId);
        if (notifyEmail) {
          await sendInfraCreditsLowEmail(notifyEmail, org.name, newBalance, 'en');
        }
      }

      await db
        .update(servers)
        .set({ infraLastChargedAt: new Date(), updatedAt: new Date() })
        .where(eq(servers.id, server.id));

      charged++;
    }

    return { charged, stopped, skipped };
  },

  billingFieldsFromQuote(quote: InfraPriceQuote, providerServerType?: string) {
    return {
      providerServerType: providerServerType ?? null,
      providerCostMonthlyCents: quote.providerCostMonthlyCents,
      providerCostHourlyCents: quote.providerCostHourlyCents,
      customerPriceMonthlyCents: quote.customerPriceMonthlyCents,
      customerPriceHourlyCents: quote.customerPriceHourlyCents,
    };
  },
};
