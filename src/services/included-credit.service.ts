import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { organizations, includedCreditGrants } from '../db/schema';
import { getIncludedInfraCreditCents, type PlanType } from '../lib/plans';
import {
  creditPeriod,
  remainingFraction,
  upgradeGrantCents,
  type BillingInterval,
  type CreditPeriod,
} from '../lib/included-credit';
import { getPlanFromPriceId, getStripe, getSubscriptionPeriod } from '../lib/stripe';
import { logger } from '../lib/logger';

/**
 * Monthly included server credit — the writes. The rules (period cutting, proration, charge
 * split) are pure functions in lib/included-credit.ts.
 *
 * Guarantees:
 * - At most one period grant per organization and period, and one upgrade top-up per period
 *   and target plan: enforced by partial unique indexes (migration 0061), so the hourly worker,
 *   invoice.paid and checkout can all call in without double-granting.
 * - A new period replaces what is left of the last one (no roll-over); the discarded remainder
 *   is recorded as an `expire` row.
 * - Only organizations whose billing is `active` receive a period grant: past_due gets nothing
 *   until the invoice is paid, and the grant for that period follows the payment.
 */

const PAID_PLANS: PlanType[] = ['hobby', 'pro', 'business'];

type Executor = typeof db;

interface OrgCreditRow {
  id: string;
  plan: PlanType;
  billingStatus: string;
  stripeSubscriptionId: string | null;
  stripeCurrentPeriodStart: Date | null;
  stripeCurrentPeriodEnd: Date | null;
  billingInterval: string | null;
  includedCreditCents: number;
  includedCreditPeriodKey: string | null;
}

const orgCreditColumns = {
  id: organizations.id,
  plan: organizations.plan,
  billingStatus: organizations.billingStatus,
  stripeSubscriptionId: organizations.stripeSubscriptionId,
  stripeCurrentPeriodStart: organizations.stripeCurrentPeriodStart,
  stripeCurrentPeriodEnd: organizations.stripeCurrentPeriodEnd,
  billingInterval: organizations.billingInterval,
  includedCreditCents: organizations.includedCreditCents,
  includedCreditPeriodKey: organizations.includedCreditPeriodKey,
};

async function loadOrg(organizationId: string, exec: Executor = db): Promise<OrgCreditRow | null> {
  const [row] = await exec.select(orgCreditColumns).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  return (row as OrgCreditRow | undefined) ?? null;
}

async function grantedThisPeriod(organizationId: string, periodKey: string, exec: Executor = db): Promise<number> {
  const [row] = await exec
    .select({ total: sql<number>`coalesce(sum(${includedCreditGrants.amountCents}), 0)::int` })
    .from(includedCreditGrants)
    .where(
      and(
        eq(includedCreditGrants.organizationId, organizationId),
        eq(includedCreditGrants.periodKey, periodKey),
        inArray(includedCreditGrants.kind, ['period', 'upgrade']),
      ),
    );
  return row?.total ?? 0;
}

export const includedCreditService = {
  async currentPlan(organizationId: string): Promise<PlanType | null> {
    return (await loadOrg(organizationId))?.plan ?? null;
  },

  /**
   * The credit period for an organization now. Reads the stored Stripe period; if it is missing
   * or over, fetches the subscription once and stores it (self-healing for subscriptions that
   * predate these columns).
   */
  async resolvePeriod(org: OrgCreditRow, now: Date = new Date()): Promise<(CreditPeriod & { stripePlan?: PlanType }) | null> {
    if (!org.stripeSubscriptionId) return null;
    let start = org.stripeCurrentPeriodStart;
    let end = org.stripeCurrentPeriodEnd;
    let interval = org.billingInterval as BillingInterval | null;
    let stripePlan: PlanType | undefined;

    if (!start || !end || !interval || end.getTime() <= now.getTime()) {
      try {
        const sub = await getStripe().subscriptions.retrieve(org.stripeSubscriptionId);
        const p = getSubscriptionPeriod(sub);
        if (!p) return null;
        ({ start, end, interval } = p);
        // The plan Stripe bills for the new period. At a scheduled downgrade, invoice.paid can
        // arrive before subscription.updated has moved our stored plan.
        const priceId = sub.items?.data?.[0]?.price?.id;
        stripePlan = (priceId && getPlanFromPriceId(priceId)) || undefined;
        await db
          .update(organizations)
          .set({ stripeCurrentPeriodStart: start, stripeCurrentPeriodEnd: end, billingInterval: interval })
          .where(eq(organizations.id, org.id));
      } catch (err) {
        logger.warn({ err, organizationId: org.id }, 'Included credit: could not read subscription period');
        return null;
      }
    }
    return { ...creditPeriod(interval!, start!, end!, now), stripePlan };
  },

  /**
   * Give the organization this period's included credit if it has not had it yet. Replaces any
   * remainder from the previous period. Returns the amount granted (0 when nothing to do).
   */
  async ensurePeriodGrant(organizationId: string, now: Date = new Date()): Promise<number> {
    const org = await loadOrg(organizationId);
    if (!org || !PAID_PLANS.includes(org.plan) || org.billingStatus !== 'active') return 0;
    const period = await this.resolvePeriod(org, now);
    if (!period || org.includedCreditPeriodKey === period.key) return 0;

    const plan = period.stripePlan ?? org.plan;
    if (!PAID_PLANS.includes(plan)) return 0;
    const amount = getIncludedInfraCreditCents(plan);
    if (amount <= 0) return 0;

    const granted = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(includedCreditGrants)
        .values({ organizationId, periodKey: period.key, kind: 'period', plan, amountCents: amount })
        .onConflictDoNothing()
        .returning({ id: includedCreditGrants.id });
      if (inserted.length === 0) return 0;

      const [current] = await tx
        .select({ cents: organizations.includedCreditCents, key: organizations.includedCreditPeriodKey })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for('update');
      if (current && current.cents > 0 && current.key && current.key !== period.key) {
        await tx.insert(includedCreditGrants).values({
          organizationId,
          periodKey: current.key,
          kind: 'expire',
          plan: org.plan,
          amountCents: -current.cents,
        });
      }
      await tx
        .update(organizations)
        .set({
          includedCreditCents: amount,
          includedCreditPeriodKey: period.key,
          includedCreditPeriodEnd: period.end,
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, organizationId));
      return amount;
    });

    if (granted > 0) {
      logger.info({ organizationId, plan, periodKey: period.key, amountCents: granted }, 'Included credit granted');
    }
    return granted;
  },

  /**
   * Plan went up mid-period (in-place change, or a pending change applied by webhook): add the
   * difference, prorated to what is left of the period and capped at the new plan's amount.
   */
  async grantUpgradeDifference(
    organizationId: string,
    fromPlan: PlanType,
    toPlan: PlanType,
    now: Date = new Date(),
  ): Promise<number> {
    const fromAmount = getIncludedInfraCreditCents(fromPlan);
    const toAmount = getIncludedInfraCreditCents(toPlan);
    if (toAmount <= fromAmount) return 0;

    const org = await loadOrg(organizationId);
    if (!org || org.billingStatus !== 'active') return 0;
    const period = await this.resolvePeriod(org, now);
    if (!period) return 0;

    // First credit of the period on the new plan already carries its full amount.
    if (org.includedCreditPeriodKey !== period.key) {
      return this.ensurePeriodGrant(organizationId, now);
    }

    const grant = upgradeGrantCents({
      fromAmountCents: fromAmount,
      toAmountCents: toAmount,
      alreadyGrantedThisPeriodCents: await grantedThisPeriod(organizationId, period.key),
      fractionRemaining: remainingFraction(period, now),
    });
    if (grant <= 0) return 0;

    const added = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(includedCreditGrants)
        .values({ organizationId, periodKey: period.key, kind: 'upgrade', plan: toPlan, amountCents: grant })
        .onConflictDoNothing()
        .returning({ id: includedCreditGrants.id });
      if (inserted.length === 0) return 0;
      await tx
        .update(organizations)
        .set({ includedCreditCents: sql`${organizations.includedCreditCents} + ${grant}`, updatedAt: new Date() })
        .where(eq(organizations.id, organizationId));
      return grant;
    });
    if (added > 0) {
      logger.info({ organizationId, fromPlan, toPlan, periodKey: period.key, amountCents: added }, 'Included credit upgrade top-up');
    }
    return added;
  },

  /** Drop what is left of the included credit (subscription ended, refund). */
  async expire(organizationId: string, reason: 'canceled' | 'refunded'): Promise<number> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ cents: organizations.includedCreditCents, key: organizations.includedCreditPeriodKey, plan: organizations.plan })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for('update');
      if (!row || row.cents <= 0) return 0;
      await tx.insert(includedCreditGrants).values({
        organizationId,
        periodKey: row.key ?? 'none',
        kind: 'expire',
        plan: row.plan,
        amountCents: -row.cents,
      });
      await tx
        .update(organizations)
        .set({ includedCreditCents: 0, updatedAt: new Date() })
        .where(eq(organizations.id, organizationId));
      logger.info({ organizationId, amountCents: row.cents, reason }, 'Included credit expired');
      return row.cents;
    });
  },

  /** Hourly: every active paid organization whose credit period is over (or never started). */
  async grantDuePeriods(now: Date = new Date()): Promise<{ checked: number; granted: number }> {
    const due = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          inArray(organizations.plan, PAID_PLANS),
          isNotNull(organizations.stripeSubscriptionId),
          eq(organizations.billingStatus, 'active'),
          or(isNull(organizations.includedCreditPeriodEnd), lte(organizations.includedCreditPeriodEnd, now)),
        ),
      );
    let granted = 0;
    for (const { id } of due) {
      try {
        if ((await this.ensurePeriodGrant(id, now)) > 0) granted++;
      } catch (err) {
        logger.error({ err, organizationId: id }, 'Included credit: period grant failed');
      }
    }
    return { checked: due.length, granted };
  },

  /** For the admin panel and refunds: what this period granted, what is left, what was used. */
  async usageThisPeriod(organizationId: string): Promise<{ periodKey: string | null; grantedCents: number; remainingCents: number; usedCents: number }> {
    const org = await loadOrg(organizationId);
    if (!org?.includedCreditPeriodKey) return { periodKey: null, grantedCents: 0, remainingCents: 0, usedCents: 0 };
    const grantedCents = await grantedThisPeriod(organizationId, org.includedCreditPeriodKey);
    const [expired] = await db
      .select({ total: sql<number>`coalesce(sum(${includedCreditGrants.amountCents}), 0)::int` })
      .from(includedCreditGrants)
      .where(
        and(
          eq(includedCreditGrants.organizationId, organizationId),
          eq(includedCreditGrants.periodKey, org.includedCreditPeriodKey),
          eq(includedCreditGrants.kind, 'expire'),
        ),
      );
    const remainingCents = org.includedCreditCents;
    const usedCents = Math.max(0, grantedCents + (expired?.total ?? 0) - remainingCents);
    return { periodKey: org.includedCreditPeriodKey, grantedCents, remainingCents, usedCents };
  },
};
