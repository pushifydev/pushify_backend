import { eq } from 'drizzle-orm';
import { db } from '../db';
import { organizations } from '../db/schema';
import { env } from '../config/env';
import {
  getStripe,
  getPriceId,
  getPlanFromPriceId,
  getSubscriptionCurrentPeriodEnd,
  getOrganizationIdFromSubscription,
} from '../lib/stripe';
import { claimStripeWebhookEvent } from '../lib/stripe-webhook-dedupe';
import { sendBillingPlanActivatedEmail, sendInfraCreditTopUpEmail } from '../lib/email';
import { resolveBillingNotifyEmail } from '../lib/billing-notify';
import { organizationRepository } from '../repositories/organization.repository';
import { getPlanInfo, type PlanType } from '../lib/plans';
import { INFRA_TOPUP_AMOUNTS_CENTS } from '../lib/infra-billing';
import { infraBillingService } from './infra-billing.service';
import { organizationBillingService } from './organization-billing.service';
import type Stripe from 'stripe';
import { logger } from '../lib/logger';

/** Stripe "No such ..." error (resource_missing / 404) — e.g. a customer or price from another mode. */
function isStripeResourceMissing(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; statusCode?: number };
  return e.code === 'resource_missing' || e.statusCode === 404;
}

export const stripeService = {
  async getOrCreateCustomer(organizationId: string, email: string): Promise<string> {
    const stripe = getStripe();

    const [org] = await db
      .select({ stripeCustomerId: organizations.stripeCustomerId, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    if (org?.stripeCustomerId) {
      // Verify the stored customer still exists in the *current* Stripe mode. A leftover
      // test-mode customer (or a manually deleted one) would otherwise break checkout with
      // "No such customer" once live keys are in use — so recreate it transparently.
      try {
        const existing = await stripe.customers.retrieve(org.stripeCustomerId);
        if (!(existing as Stripe.DeletedCustomer).deleted) {
          return existing.id;
        }
      } catch (err) {
        if (!isStripeResourceMissing(err)) throw err;
      }
      logger.warn(
        { organizationId, staleCustomerId: org.stripeCustomerId },
        'Stored Stripe customer not found in current mode — recreating',
      );
    }

    const customer = await stripe.customers.create({
      email,
      name: org?.name || undefined,
      metadata: { organizationId },
    });

    await db
      .update(organizations)
      .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
      .where(eq(organizations.id, organizationId));

    return customer.id;
  },

  async createCheckoutSession(
    organizationId: string,
    userId: string,
    email: string,
    planType: PlanType,
    billingCycle: 'monthly' | 'yearly',
  ): Promise<string> {
    const stripe = getStripe();
    const customerId = await this.getOrCreateCustomer(organizationId, email);
    const priceId = getPriceId(planType, billingCycle);

    if (!priceId) {
      throw new Error(`No Stripe price configured for plan: ${planType} (${billingCycle})`);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${env.FRONTEND_URL}/dashboard/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.FRONTEND_URL}/dashboard/billing/plans`,
      metadata: {
        organizationId,
        userId,
        planType,
        billingCycle,
      },
      subscription_data: {
        metadata: {
          organizationId,
          planType,
        },
      },
      allow_promotion_codes: true,
    });

    if (!session.url) {
      throw new Error('Failed to create checkout session');
    }

    return session.url;
  },

  /**
   * One-time checkout to add prepaid infrastructure credits (USD wallet).
   */
  async createInfraTopUpSession(
    organizationId: string,
    userId: string,
    email: string,
    amountCents: number,
  ): Promise<string> {
    if (!INFRA_TOPUP_AMOUNTS_CENTS.includes(amountCents as (typeof INFRA_TOPUP_AMOUNTS_CENTS)[number])) {
      throw new Error('INVALID_TOPUP_AMOUNT');
    }

    const stripe = getStripe();
    const customerId = await this.getOrCreateCustomer(organizationId, email);

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: amountCents,
            product_data: {
              name: 'Pushify Infrastructure Credits',
              description: `Prepaid cloud server credits ($${(amountCents / 100).toFixed(2)})`,
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${env.FRONTEND_URL}/dashboard/billing?infra_topup=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.FRONTEND_URL}/dashboard/billing?infra_topup=cancelled`,
      metadata: {
        organizationId,
        userId,
        checkoutType: 'infra_credit',
        amountCents: String(amountCents),
      },
    });

    if (!session.url) {
      throw new Error('Failed to create checkout session');
    }

    return session.url;
  },

  async createPortalSession(organizationId: string): Promise<string> {
    const stripe = getStripe();

    const [org] = await db
      .select({ stripeCustomerId: organizations.stripeCustomerId })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    if (!org?.stripeCustomerId) {
      throw new Error('No Stripe customer found for this organization');
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: `${env.FRONTEND_URL}/dashboard/billing`,
    });

    return session.url;
  },

  async cancelSubscription(organizationId: string): Promise<void> {
    const stripe = getStripe();

    const [org] = await db
      .select({ stripeSubscriptionId: organizations.stripeSubscriptionId })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    if (!org?.stripeSubscriptionId) {
      throw new Error('No active subscription found');
    }

    await stripe.subscriptions.update(org.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
  },

  async resumeSubscription(organizationId: string): Promise<void> {
    const stripe = getStripe();

    const [org] = await db
      .select({ stripeSubscriptionId: organizations.stripeSubscriptionId })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    if (!org?.stripeSubscriptionId) {
      throw new Error('No subscription found');
    }

    await stripe.subscriptions.update(org.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });
  },

  async getSubscriptionStatus(organizationId: string) {
    const [org] = await db
      .select({
        plan: organizations.plan,
        stripeSubscriptionId: organizations.stripeSubscriptionId,
        stripeCurrentPeriodEnd: organizations.stripeCurrentPeriodEnd,
        stripeCustomerId: organizations.stripeCustomerId,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    if (!org) {
      throw new Error('Organization not found');
    }

    let cancelAtPeriodEnd = false;

    if (org.stripeSubscriptionId) {
      try {
        const stripe = getStripe();
        const sub = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
        cancelAtPeriodEnd = sub.cancel_at_period_end;
      } catch {
        // Subscription may have been deleted
      }
    }

    return {
      plan: org.plan,
      stripeSubscriptionId: org.stripeSubscriptionId,
      currentPeriodEnd: org.stripeCurrentPeriodEnd?.toISOString() || null,
      cancelAtPeriodEnd,
      hasPaymentMethod: !!org.stripeCustomerId,
    };
  },

  /**
   * Credit infra wallet from a completed Stripe Checkout (payment mode).
   * Idempotent per checkout session id. Used by webhooks and post-redirect confirm.
   */
  async applyInfraCreditFromCheckoutSession(
    session: Stripe.Checkout.Session,
    expectedOrganizationId?: string,
  ): Promise<{ applied: boolean; created: boolean; newBalance: number; amountCents: number }> {
    const organizationId = session.metadata?.organizationId;
    const checkoutType = session.metadata?.checkoutType;

    if (!organizationId || checkoutType !== 'infra_credit') {
      return { applied: false, created: false, newBalance: 0, amountCents: 0 };
    }

    if (expectedOrganizationId && organizationId !== expectedOrganizationId) {
      throw new Error('CHECKOUT_ORG_MISMATCH');
    }

    const amountCents = parseInt(session.metadata?.amountCents || '0', 10);
    if (amountCents <= 0) {
      return { applied: false, created: false, newBalance: 0, amountCents: 0 };
    }

    if (session.payment_status !== 'paid') {
      return { applied: false, created: false, newBalance: 0, amountCents: 0 };
    }

    const sessionId = session.id;
    if (!sessionId) {
      throw new Error('CHECKOUT_SESSION_ID_MISSING');
    }

    const { balanceAfterCents, created } = await infraBillingService.creditWallet(
      organizationId,
      amountCents,
      `Stripe top-up $${(amountCents / 100).toFixed(2)}`,
      sessionId,
    );

    return { applied: true, created, newBalance: balanceAfterCents, amountCents };
  },

  async confirmInfraTopUp(organizationId: string, sessionId: string) {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const result = await this.applyInfraCreditFromCheckoutSession(session, organizationId);

    if (!result.applied) {
      const wallet = await infraBillingService.getWalletSummary(organizationId);
      return {
        credited: false,
        paymentStatus: session.payment_status,
        balanceCents: wallet.balanceCents,
      };
    }

    if (result.created) {
      const org = await organizationRepository.findById(organizationId);
      const notifyEmail = await resolveBillingNotifyEmail(organizationId);
      if (notifyEmail && org) {
        await sendInfraCreditTopUpEmail(
          notifyEmail,
          org.name,
          result.amountCents,
          result.newBalance,
          'en',
        );
      }

      logger.info(
        { organizationId, sessionId, amountCents: result.amountCents },
        'Infra wallet credited via checkout confirm',
      );
    }

    return {
      credited: result.applied,
      alreadyCredited: result.applied && !result.created,
      paymentStatus: session.payment_status,
      balanceCents: result.newBalance,
      amountCents: result.amountCents,
    };
  },

  async handleWebhookEvent(payload: string, signature: string): Promise<void> {
    const stripe = getStripe();

    if (!env.STRIPE_WEBHOOK_SECRET) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }

    const event = stripe.webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);

    const shouldProcess = await claimStripeWebhookEvent(event.id);
    if (!shouldProcess) {
      return;
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const organizationId = session.metadata?.organizationId;
        const checkoutType = session.metadata?.checkoutType;

        if (!organizationId) break;

        if (checkoutType === 'infra_credit') {
          const result = await this.applyInfraCreditFromCheckoutSession(session);
          if (result.applied && result.created) {
            logger.info({ organizationId, amountCents: result.amountCents }, 'Infra wallet credited via Stripe webhook');
            const org = await organizationRepository.findById(organizationId);
            const notifyEmail = await resolveBillingNotifyEmail(organizationId);
            if (notifyEmail && org) {
              await sendInfraCreditTopUpEmail(
                notifyEmail,
                org.name,
                result.amountCents,
                result.newBalance,
                'en',
              );
            }
          }
          break;
        }

        const planType = session.metadata?.planType as PlanType | undefined;
        if (!planType) break;

        const subscriptionId = typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id;

        if (subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          const periodEnd = getSubscriptionCurrentPeriodEnd(sub);

          // Derive the plan from the subscription's actual Price ID rather than trusting
          // the client-supplied metadata.planType (H-4). Fall back to metadata only if the
          // price isn't in our map.
          const priceId = sub.items.data[0]?.price?.id;
          const pricePlan = priceId ? getPlanFromPriceId(priceId) : null;
          if (pricePlan && pricePlan !== planType) {
            logger.warn(
              { organizationId, metadataPlan: planType, pricePlan, priceId },
              'checkout.session.completed: metadata planType disagrees with paid price; using price',
            );
          }
          const effectivePlan = pricePlan ?? planType;

          await db
            .update(organizations)
            .set({
              plan: effectivePlan,
              stripeSubscriptionId: subscriptionId,
              billingStatus: 'active',
              billingPaymentFailedNotifiedAt: null,
              ...(periodEnd ? { stripeCurrentPeriodEnd: periodEnd } : {}),
              updatedAt: new Date(),
            })
            .where(eq(organizations.id, organizationId));

          // Fund the included compute credit so the customer can start their entry server
          // without a separate top-up (tops the wallet up to the plan allowance; never above).
          await infraBillingService.grantIncludedInfraCredit(organizationId, effectivePlan);

          const org = await organizationRepository.findById(organizationId);
          const notifyEmail = await resolveBillingNotifyEmail(organizationId);
          if (notifyEmail && org) {
            const planName = getPlanInfo(effectivePlan).name;
            await sendBillingPlanActivatedEmail(notifyEmail, org.name, planName, 'en');
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        // Authoritative mapping is OUR stored subscription→org link, not the mutable Stripe
        // metadata (which an attacker could point at another tenant). Use the DB first and
        // fall back to metadata only when we have no stored link yet (first event). — H-5
        const [orgBySub] = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.stripeSubscriptionId, sub.id))
          .limit(1);
        const organizationId = orgBySub?.id ?? getOrganizationIdFromSubscription(sub);

        if (!organizationId) {
          logger.warn({ subscriptionId: sub.id }, 'subscription.updated: organization not found');
          break;
        }

        const priceId = sub.items.data[0]?.price?.id;
        const newPlan = priceId ? getPlanFromPriceId(priceId) : null;
        const periodEnd = getSubscriptionCurrentPeriodEnd(sub);

        const updateData: Record<string, unknown> = {
          updatedAt: new Date(),
          stripeSubscriptionId: sub.id,
        };

        if (periodEnd) {
          updateData.stripeCurrentPeriodEnd = periodEnd;
        }

        if (newPlan) {
          updateData.plan = newPlan;
        }

        if (sub.status === 'active' || sub.status === 'trialing') {
          updateData.billingStatus = 'active';
          updateData.billingPaymentFailedNotifiedAt = null;
        } else if (sub.status === 'past_due' || sub.status === 'unpaid') {
          updateData.billingStatus = 'past_due';
        }

        await db
          .update(organizations)
          .set(updateData)
          .where(eq(organizations.id, organizationId));

        logger.info(
          { organizationId, subscriptionId: sub.id, plan: newPlan, status: sub.status, periodEnd: periodEnd?.toISOString() },
          'subscription.updated processed',
        );
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        // Authoritative mapping is OUR stored subscription→org link, not the mutable Stripe
        // metadata (which an attacker could point at another tenant). Use the DB first and
        // fall back to metadata only when we have no stored link yet (first event). — H-5
        const [orgBySub] = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.stripeSubscriptionId, sub.id))
          .limit(1);
        const organizationId = orgBySub?.id ?? getOrganizationIdFromSubscription(sub);

        if (!organizationId) break;

        await db
          .update(organizations)
          .set({
            plan: 'free',
            stripeSubscriptionId: null,
            stripeCurrentPeriodEnd: null,
            updatedAt: new Date(),
          })
          .where(eq(organizations.id, organizationId));

        await organizationBillingService.suspendOrganization(organizationId);
        logger.info({ organizationId }, 'subscription.deleted: organization suspended');
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId =
          typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;

        if (!customerId) break;

        const [org] = await db
          .select({ id: organizations.id, plan: organizations.plan })
          .from(organizations)
          .where(eq(organizations.stripeCustomerId, customerId))
          .limit(1);

        if (org) {
          await organizationBillingService.markActive(org.id);
          // Renew the included compute credit each paid cycle (tops up to the plan allowance).
          await infraBillingService.grantIncludedInfraCredit(org.id, org.plan as PlanType);
          logger.info({ organizationId: org.id }, 'invoice.paid: billing status cleared, infra credit renewed');
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId =
          typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;

        if (!customerId) break;

        const [org] = await db
          .select({
            id: organizations.id,
            name: organizations.name,
          })
          .from(organizations)
          .where(eq(organizations.stripeCustomerId, customerId))
          .limit(1);

        if (!org) break;

        await organizationBillingService.markPastDue(org.id);
        const emailed = await organizationBillingService.notifyPaymentFailedIfDue(org.id, org.name);
        if (!emailed) {
          logger.warn({ organizationId: org.id }, 'payment_failed: notification skipped or no billing email');
        }
        break;
      }
    }
  },
};
