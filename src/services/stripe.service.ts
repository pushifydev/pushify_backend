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
import { adminNotify } from './admin-notify.service';
import { logger } from '../lib/logger';

/** Stripe "No such ..." error (resource_missing / 404) — e.g. a customer or price from another mode. */
function isStripeResourceMissing(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; statusCode?: number };
  return e.code === 'resource_missing' || e.statusCode === 404;
}

/** Hosted invoice URL for a subscription checkout session (best-effort). */
async function getSessionInvoiceUrl(session: Stripe.Checkout.Session): Promise<string | null> {
  try {
    if (!session.invoice) return null;
    const stripe = getStripe();
    const invoiceId = typeof session.invoice === 'string' ? session.invoice : session.invoice.id;
    const invoice = await stripe.invoices.retrieve(invoiceId);
    return invoice.hosted_invoice_url ?? null;
  } catch {
    return null;
  }
}

/** Stripe receipt URL for a one-time payment checkout session (best-effort). */
async function getSessionReceiptUrl(session: Stripe.Checkout.Session): Promise<string | null> {
  try {
    if (!session.payment_intent) return null;
    const stripe = getStripe();
    const piId =
      typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id;
    const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['latest_charge'] });
    const charge = pi.latest_charge;
    return charge && typeof charge === 'object' ? (charge.receipt_url ?? null) : null;
  } catch {
    return null;
  }
}


/** Subscriptions that are still billing: a second checkout on top of one would double-charge. */
const LIVE_SUBSCRIPTION_STATUSES: Stripe.Subscription.Status[] = ['active', 'trialing', 'past_due', 'unpaid'];

/** Monthly-normalised amount of a recurring price, to tell an upgrade from a downgrade. */
function monthlyCents(price: Stripe.Price): number {
  const amount = price.unit_amount ?? 0;
  const interval = price.recurring?.interval;
  const count = price.recurring?.interval_count ?? 1;
  if (interval === 'year') return amount / (12 * count);
  if (interval === 'week') return (amount * 52) / (12 * count);
  if (interval === 'day') return (amount * 365) / (12 * count);
  return amount / count;
}

export type PlanChangeResult =
  | { status: 'changed'; plan: PlanType }
  /** The card was declined or needs 3D Secure: nothing changed yet; paying this URL applies it. */
  | { status: 'payment_required'; payUrl: string | null }
  /** No subscription to change: start one with Checkout. */
  | { status: 'checkout_required' };

export type PayOutstandingResult =
  | { status: 'paid'; paidCount: number }
  | { status: 'nothing_due' }
  | { status: 'payment_required'; payUrl: string | null };

async function openInvoicesFor(stripe: Stripe, customerId: string): Promise<Stripe.Invoice[]> {
  const out: Stripe.Invoice[] = [];
  for await (const inv of stripe.invoices.list({ customer: customerId, status: 'open', limit: 100 })) out.push(inv);
  // Oldest first: pay what is most overdue first.
  return out.sort((a, b) => a.created - b.created);
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

  /**
   * One-time checkout to buy a domain by card when wallet credits don't cover it.
   * The webhook credits the wallet with the paid amount, then registers the domain.
   */
  async createDomainPurchaseSession(params: {
    organizationId: string;
    userId: string;
    email: string;
    domainName: string;
    years: number;
    amountCents: number;
    projectId?: string;
    locale: string;
  }): Promise<string> {
    const stripe = getStripe();
    const customerId = await this.getOrCreateCustomer(params.organizationId, params.email);

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: params.amountCents,
            product_data: {
              name: `Domain: ${params.domainName}`,
              description: `${params.years}-year registration via Pushify`,
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${env.FRONTEND_URL}/dashboard/domains?domain_purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.FRONTEND_URL}/dashboard/domains?domain_purchase=cancelled`,
      metadata: {
        organizationId: params.organizationId,
        userId: params.userId,
        checkoutType: 'domain_purchase',
        domainName: params.domainName,
        years: String(params.years),
        amountCents: String(params.amountCents),
        projectId: params.projectId ?? '',
        locale: params.locale,
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

  /**
   * Switch an existing subscription to another plan or billing cycle, in place.
   *
   * Upgrades are charged right away with proration from the saved card
   * (`always_invoice` + `pending_if_incomplete`): if the card is declined or needs 3D Secure,
   * Stripe keeps the old plan and holds the change as a pending update, and we hand back the
   * invoice's hosted page — paying it applies the change (then `customer.subscription.updated`
   * moves the plan here). Downgrades take effect now and the unused time is credited to the next
   * invoice. Before this, every change went through a new Checkout, which started a second
   * subscription next to the first.
   */
  async changePlan(
    organizationId: string,
    planType: PlanType,
    billingCycle: 'monthly' | 'yearly',
  ): Promise<PlanChangeResult> {
    const stripe = getStripe();
    const [org] = await db
      .select({ stripeSubscriptionId: organizations.stripeSubscriptionId, billingStatus: organizations.billingStatus })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!org?.stripeSubscriptionId) return { status: 'checkout_required' };

    let sub: Stripe.Subscription;
    try {
      sub = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
    } catch (err) {
      if (isStripeResourceMissing(err)) return { status: 'checkout_required' };
      throw err;
    }
    if (!LIVE_SUBSCRIPTION_STATUSES.includes(sub.status)) return { status: 'checkout_required' };

    // Money owed first: a plan change on top of an unpaid invoice would pile a second charge on it.
    if (sub.status === 'past_due' || sub.status === 'unpaid' || org.billingStatus === 'past_due') {
      const due = await this.payOutstanding(organizationId);
      if (due.status === 'payment_required') return due;
    }

    const priceId = getPriceId(planType, billingCycle);
    if (!priceId) throw new Error(`No Stripe price configured for plan: ${planType} (${billingCycle})`);
    const item = sub.items.data[0];
    if (!item) return { status: 'checkout_required' };
    if (item.price.id === priceId) {
      if (sub.cancel_at_period_end) await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
      return { status: 'changed', plan: planType };
    }

    const target = await stripe.prices.retrieve(priceId);
    const isUpgrade = monthlyCents(target) > monthlyCents(item.price) || target.recurring?.interval !== item.price.recurring?.interval;

    const updated = await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: priceId }],
      cancel_at_period_end: false,
      metadata: { ...sub.metadata, organizationId, planType },
      ...(isUpgrade
        ? { proration_behavior: 'always_invoice', payment_behavior: 'pending_if_incomplete' }
        : { proration_behavior: 'create_prorations' }),
      expand: ['latest_invoice'],
    });

    if (updated.pending_update) {
      const invoice = updated.latest_invoice as Stripe.Invoice | null;
      logger.info({ organizationId, subscriptionId: sub.id, planType }, 'plan change held: payment required');
      return { status: 'payment_required', payUrl: invoice?.hosted_invoice_url ?? null };
    }

    const periodEnd = getSubscriptionCurrentPeriodEnd(updated);
    await db
      .update(organizations)
      .set({
        plan: planType,
        billingStatus: 'active',
        billingPaymentFailedNotifiedAt: null,
        ...(periodEnd ? { stripeCurrentPeriodEnd: periodEnd } : {}),
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, organizationId));
    if (isUpgrade) await infraBillingService.grantIncludedInfraCredit(organizationId, planType);
    logger.info({ organizationId, subscriptionId: sub.id, planType, isUpgrade }, 'plan changed in place');
    return { status: 'changed', plan: planType };
  },

  /**
   * Collect whatever is owed now: retry every open invoice against the saved card. What the
   * card can't cover comes back as the oldest unpaid invoice's hosted page, where the customer
   * can pay with another card or confirm 3D Secure.
   */
  async payOutstanding(organizationId: string): Promise<PayOutstandingResult> {
    const stripe = getStripe();
    const [org] = await db
      .select({ stripeCustomerId: organizations.stripeCustomerId })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!org?.stripeCustomerId) return { status: 'nothing_due' };

    const open = await openInvoicesFor(stripe, org.stripeCustomerId);
    if (open.length === 0) return { status: 'nothing_due' };

    let paidCount = 0;
    for (const invoice of open) {
      try {
        const paid = await stripe.invoices.pay(invoice.id!);
        if (paid.status === 'paid') {
          paidCount++;
          continue;
        }
      } catch (err) {
        logger.info({ organizationId, invoiceId: invoice.id, code: (err as { code?: string }).code }, 'invoice retry failed');
      }
      return { status: 'payment_required', payUrl: invoice.hosted_invoice_url ?? null };
    }

    // invoice.paid webhooks clear past_due too; doing it here means the page is right on return.
    await organizationBillingService.markActive(organizationId);
    return { status: 'paid', paidCount };
  },

  /** Stripe's own card-update screen for this customer, straight to the form. */
  async createPaymentMethodUpdateSession(organizationId: string): Promise<string> {
    const stripe = getStripe();
    const [org] = await db
      .select({ stripeCustomerId: organizations.stripeCustomerId })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!org?.stripeCustomerId) throw new Error('No Stripe customer found for this organization');

    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: `${env.FRONTEND_URL}/dashboard/billing?card=updated`,
      flow_data: {
        type: 'payment_method_update',
        after_completion: {
          type: 'redirect',
          redirect: { return_url: `${env.FRONTEND_URL}/dashboard/billing?card=updated` },
        },
      },
    });
    return session.url;
  },

  /** True when the organisation already has a subscription that is still billing. */
  async hasLiveSubscription(organizationId: string): Promise<boolean> {
    const [org] = await db
      .select({ stripeSubscriptionId: organizations.stripeSubscriptionId })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!org?.stripeSubscriptionId) return false;
    try {
      const sub = await getStripe().subscriptions.retrieve(org.stripeSubscriptionId);
      return LIVE_SUBSCRIPTION_STATUSES.includes(sub.status);
    } catch (err) {
      if (isStripeResourceMissing(err)) return false;
      throw err;
    }
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
          await getSessionReceiptUrl(session),
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

  /**
   * Post-redirect fulfillment for a card-paid domain purchase. Mirrors
   * confirmInfraTopUp: the success page confirms the session directly, so local
   * setups without webhook forwarding (and slow webhooks in prod) still register
   * the domain immediately. Idempotent with the webhook per checkout session id.
   */
  async confirmDomainPurchase(
    organizationId: string,
    sessionId: string,
  ): Promise<{ fulfilled: boolean; alreadyProcessed: boolean; paymentStatus: string | null }> {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const meta = session.metadata ?? {};

    if (meta.checkoutType !== 'domain_purchase' || !meta.domainName || !meta.userId) {
      throw new Error('CHECKOUT_SESSION_INVALID');
    }
    if (meta.organizationId !== organizationId) {
      throw new Error('CHECKOUT_ORG_MISMATCH');
    }
    if (session.payment_status !== 'paid') {
      return { fulfilled: false, alreadyProcessed: false, paymentStatus: session.payment_status };
    }

    const amountCents = parseInt(meta.amountCents || '0', 10);
    const years = parseInt(meta.years || '1', 10);
    if (amountCents <= 0) {
      throw new Error('CHECKOUT_SESSION_INVALID');
    }

    const { registrarDomainService } = await import('./registrar-domain.service');
    const result = await registrarDomainService.fulfillCheckout({
      sessionId: session.id,
      organizationId,
      userId: meta.userId,
      domainName: meta.domainName,
      years: Number.isInteger(years) && years > 0 ? years : 1,
      projectId: meta.projectId || undefined,
      locale: meta.locale === 'tr' ? 'tr' : 'en',
      amountCents,
    });
    return { ...result, paymentStatus: session.payment_status };
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
        adminNotify('subscription.activated', {
          stripeEvent: event.type,
          organizationId: (event.data.object as { metadata?: { organizationId?: string } }).metadata?.organizationId,
        });
        const session = event.data.object as Stripe.Checkout.Session;
        const organizationId = session.metadata?.organizationId;
        const checkoutType = session.metadata?.checkoutType;

        if (!organizationId) break;

        if (checkoutType === 'domain_purchase') {
          if (session.payment_status !== 'paid') break;
          const meta = session.metadata ?? {};
          const amountCents = parseInt(meta.amountCents || '0', 10);
          const years = parseInt(meta.years || '1', 10);
          if (!meta.domainName || !meta.userId || amountCents <= 0) break;
          const { registrarDomainService } = await import('./registrar-domain.service');
          const result = await registrarDomainService.fulfillCheckout({
            sessionId: session.id,
            organizationId,
            userId: meta.userId,
            domainName: meta.domainName,
            years: Number.isInteger(years) && years > 0 ? years : 1,
            projectId: meta.projectId || undefined,
            locale: meta.locale === 'tr' ? 'tr' : 'en',
            amountCents,
          });
          logger.info(
            { organizationId, domainName: meta.domainName, ...result },
            'Domain checkout webhook processed'
          );
          break;
        }

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
                await getSessionReceiptUrl(session),
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
            await sendBillingPlanActivatedEmail(notifyEmail, org.name, planName, 'en', await getSessionInvoiceUrl(session));
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
        adminNotify('subscription.canceled', { stripeEvent: event.type });
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

      case 'invoice.payment_failed':
      case 'invoice.payment_action_required': {
        const actionRequired = event.type === 'invoice.payment_action_required';
        if (!actionRequired) adminNotify('payment.failed', { stripeEvent: event.type });
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

        // 3D Secure is not a failure: the subscription is fine until the bank's window closes.
        if (!actionRequired) await organizationBillingService.markPastDue(org.id);
        // Straight to the invoice's own payment page: one click to pay, with any card.
        const emailed = await organizationBillingService.notifyPaymentFailedIfDue(
          org.id,
          org.name,
          invoice.hosted_invoice_url ?? null,
          actionRequired ? 'action_required' : 'failed',
        );
        if (!emailed) {
          logger.warn({ organizationId: org.id }, 'payment_failed: notification skipped or no billing email');
        }
        break;
      }

      case 'customer.updated': {
        // A new default card: retry what is owed right away instead of waiting for Stripe's next
        // scheduled attempt (days away) — the customer just fixed their card to pay.
        const customer = event.data.object as Stripe.Customer;
        const previous = event.data.previous_attributes as { invoice_settings?: unknown } | undefined;
        if (!previous?.invoice_settings) break;
        const [org] = await db
          .select({ id: organizations.id, billingStatus: organizations.billingStatus })
          .from(organizations)
          .where(eq(organizations.stripeCustomerId, customer.id))
          .limit(1);
        if (!org || org.billingStatus === 'active') break;
        const result = await this.payOutstanding(org.id).catch((err) => {
          logger.warn({ err, organizationId: org.id }, 'retry after card update failed');
          return null;
        });
        logger.info({ organizationId: org.id, result: result?.status }, 'customer.updated: retried open invoices');
        break;
      }
    }
  },
};
