import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { db } from '../db';
import { organizations } from '../db/schema';
import { getPlanFromPriceId, getStripe } from '../lib/stripe';
import type { PlanType } from '../lib/plans';
import { logger } from '../lib/logger';

/**
 * Downgrades (and other non-upgrade changes) take effect at the end of the current period, with
 * no proration: the current period continues on the plan that was paid for (refund policy 7.2).
 * A Stripe subscription schedule carries the change — Stripe switches the price at the period
 * boundary itself, so its renewal invoice is already on the new price.
 *
 * Our copy of the pending change (organizations.pending_*) is a mirror of the schedule: every
 * subscription_schedule.* event and every subscription update re-derives it from Stripe, so a
 * schedule edited, released or cancelled in the Stripe dashboard (or one that fails) never leaves
 * a stale "changes on …" behind.
 */

type Interval = 'month' | 'year';

const TERMINAL_STATUSES = new Set(['released', 'canceled', 'completed']);

function priceId(p: string | Stripe.Price | Stripe.DeletedPrice | undefined | null): string | null {
  if (!p) return null;
  return typeof p === 'string' ? p : p.id;
}

function scheduleId(s: string | Stripe.SubscriptionSchedule | null | undefined): string | null {
  if (!s) return null;
  return typeof s === 'string' ? s : s.id;
}

export interface PendingChange {
  plan: PlanType;
  interval: Interval | null;
  effectiveAt: Date;
  scheduleId: string;
}

/**
 * The change a schedule will make: the price of the phase after the current one, if it differs
 * from the current phase's price. `null` when the schedule is over or changes nothing.
 */
export function pendingChangeFromSchedule(
  schedule: Stripe.SubscriptionSchedule,
  nowSec: number = Math.floor(Date.now() / 1000),
): PendingChange | null {
  if (TERMINAL_STATUSES.has(schedule.status)) return null;
  const phases = schedule.phases ?? [];
  const currentIndex = phases.findIndex((p) => p.start_date <= nowSec && nowSec < p.end_date);
  const current = currentIndex >= 0 ? phases[currentIndex] : phases[0];
  const next = currentIndex >= 0 ? phases[currentIndex + 1] : phases[1];
  if (!current || !next) return null;
  const currentPrice = priceId(current.items?.[0]?.price);
  const nextPrice = priceId(next.items?.[0]?.price);
  if (!nextPrice || nextPrice === currentPrice) return null;
  const plan = getPlanFromPriceId(nextPrice);
  if (!plan) return null;
  const nextItem = next.items?.[0]?.price;
  const interval =
    nextItem && typeof nextItem !== 'string' && 'recurring' in nextItem ? ((nextItem.recurring?.interval as Interval) ?? null) : null;
  return { plan, interval, effectiveAt: new Date(current.end_date * 1000), scheduleId: schedule.id };
}

async function writePending(organizationId: string, pending: PendingChange | null): Promise<void> {
  await db
    .update(organizations)
    .set(
      pending
        ? {
            pendingPlan: pending.plan,
            pendingBillingInterval: pending.interval,
            pendingChangeAt: pending.effectiveAt,
            stripeScheduleId: pending.scheduleId,
            updatedAt: new Date(),
          }
        : { pendingPlan: null, pendingBillingInterval: null, pendingChangeAt: null, stripeScheduleId: null, updatedAt: new Date() },
    )
    .where(eq(organizations.id, organizationId));
}

export const planScheduleService = {
  /**
   * Switch the subscription to `targetPriceId` at the end of its current period. Reuses the
   * subscription's schedule if it already has one (a second downgrade replaces the first).
   */
  async scheduleChange(
    organizationId: string,
    sub: Stripe.Subscription,
    targetPriceId: string,
    targetPlan: PlanType,
  ): Promise<PendingChange> {
    const stripe = getStripe();
    const existingId = scheduleId(sub.schedule);
    const schedule = existingId
      ? await stripe.subscriptionSchedules.retrieve(existingId)
      : await stripe.subscriptionSchedules.create({ from_subscription: sub.id });

    const nowSec = Math.floor(Date.now() / 1000);
    const current =
      schedule.phases.find((p) => p.start_date <= nowSec && nowSec < p.end_date) ?? schedule.phases[0];
    const currentItem = sub.items.data[0];
    const target = await stripe.prices.retrieve(targetPriceId);
    const interval = (target.recurring?.interval ?? 'month') as Interval;

    const updated = await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: 'release',
      proration_behavior: 'none',
      metadata: { organizationId, pendingPlan: targetPlan },
      phases: [
        {
          items: [{ price: currentItem.price.id, quantity: currentItem.quantity ?? 1 }],
          start_date: current.start_date,
          end_date: current.end_date,
          proration_behavior: 'none',
        },
        {
          items: [{ price: targetPriceId, quantity: currentItem.quantity ?? 1 }],
          duration: { interval, interval_count: target.recurring?.interval_count ?? 1 },
          proration_behavior: 'none',
          metadata: { organizationId, planType: targetPlan },
        },
      ],
      expand: ['phases.items.price'],
    });

    const pending = pendingChangeFromSchedule(updated, nowSec) ?? {
      plan: targetPlan,
      interval,
      effectiveAt: new Date(current.end_date * 1000),
      scheduleId: updated.id,
    };
    await writePending(organizationId, pending);
    logger.info({ organizationId, scheduleId: updated.id, plan: targetPlan, effectiveAt: pending.effectiveAt.toISOString() }, 'plan change scheduled for period end');
    return pending;
  },

  /**
   * Drop a pending change: release the schedule (the subscription stays on its current price)
   * and clear our mirror. Safe to call when there is nothing to release.
   */
  async releasePending(organizationId: string, sub?: Stripe.Subscription | null): Promise<boolean> {
    const [org] = await db
      .select({ stripeScheduleId: organizations.stripeScheduleId, stripeSubscriptionId: organizations.stripeSubscriptionId })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    const stripe = getStripe();
    let id = scheduleId(sub?.schedule) ?? org?.stripeScheduleId ?? null;
    if (!id && org?.stripeSubscriptionId && !sub) {
      try {
        id = scheduleId((await stripe.subscriptions.retrieve(org.stripeSubscriptionId)).schedule);
      } catch {
        id = null;
      }
    }
    let released = false;
    if (id) {
      try {
        const schedule = await stripe.subscriptionSchedules.retrieve(id);
        if (!TERMINAL_STATUSES.has(schedule.status)) {
          await stripe.subscriptionSchedules.release(id);
          released = true;
        }
      } catch (err) {
        logger.warn({ err, organizationId, scheduleId: id }, 'could not release subscription schedule');
        throw err;
      }
    }
    await writePending(organizationId, null);
    if (released) logger.info({ organizationId, scheduleId: id }, 'scheduled plan change released');
    return released;
  },

  /**
   * subscription_schedule.* webhook: re-derive the pending change from the schedule itself.
   * The organization is found by the schedule's subscription (our stored link), never by
   * metadata alone.
   */
  async syncFromSchedule(schedule: Stripe.SubscriptionSchedule): Promise<void> {
    const subId = typeof schedule.subscription === 'string' ? schedule.subscription : schedule.subscription?.id ?? null;
    const [bySub] = subId
      ? await db
          .select({ id: organizations.id, stripeScheduleId: organizations.stripeScheduleId })
          .from(organizations)
          .where(eq(organizations.stripeSubscriptionId, subId))
          .limit(1)
      : [];
    const [bySchedule] = bySub
      ? [bySub]
      : await db
          .select({ id: organizations.id, stripeScheduleId: organizations.stripeScheduleId })
          .from(organizations)
          .where(eq(organizations.stripeScheduleId, schedule.id))
          .limit(1);
    const org = bySub ?? bySchedule;
    if (!org) {
      logger.warn({ scheduleId: schedule.id }, 'subscription_schedule event: organization not found');
      return;
    }

    const full =
      schedule.phases?.some((p) => typeof p.items?.[0]?.price === 'string')
        ? await getStripe().subscriptionSchedules.retrieve(schedule.id, { expand: ['phases.items.price'] })
        : schedule;
    const pending = pendingChangeFromSchedule(full);
    // A terminal event for a schedule that is no longer ours must not wipe a newer one.
    if (!pending && org.stripeScheduleId && org.stripeScheduleId !== schedule.id) return;
    await writePending(org.id, pending);
    logger.info({ organizationId: org.id, scheduleId: schedule.id, status: schedule.status, pendingPlan: pending?.plan ?? null }, 'subscription schedule synced');
  },

  /**
   * customer.subscription.updated/deleted: a subscription without a schedule has no pending
   * change (the schedule was released, completed or cancelled).
   */
  async reconcileFromSubscription(organizationId: string, sub: Stripe.Subscription | null): Promise<void> {
    if (!sub || !sub.schedule || sub.status === 'canceled') {
      await writePending(organizationId, null);
      return;
    }
    // The subscription already bills the pending plan (and cycle): the change has happened. The
    // schedule's last phase would otherwise stay "active" for another period and keep showing
    // the change as pending, so release it now; the subscription keeps its current price.
    const [org] = await db
      .select({ pendingPlan: organizations.pendingPlan, pendingBillingInterval: organizations.pendingBillingInterval })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    const price = sub.items?.data?.[0]?.price;
    const currentPlan = price ? getPlanFromPriceId(price.id) : null;
    const intervalMatches = !org?.pendingBillingInterval || price?.recurring?.interval === org.pendingBillingInterval;
    if (org?.pendingPlan && currentPlan === org.pendingPlan && intervalMatches) {
      const id = scheduleId(sub.schedule);
      if (id) {
        try {
          const schedule = await getStripe().subscriptionSchedules.retrieve(id);
          if (!TERMINAL_STATUSES.has(schedule.status)) await getStripe().subscriptionSchedules.release(id);
        } catch (err) {
          logger.warn({ err, organizationId, scheduleId: id }, 'could not release a completed plan-change schedule');
        }
      }
      await writePending(organizationId, null);
      logger.info({ organizationId, plan: currentPlan }, 'scheduled plan change took effect');
    }
  },
};
