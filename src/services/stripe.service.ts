import { eq } from 'drizzle-orm';
import { db } from '../db';
import { organizations } from '../db/schema';
import { env } from '../config/env';
import { getStripe, getPriceId, getPlanFromPriceId } from '../lib/stripe';
import type { PlanType } from '../lib/plans';
import type Stripe from 'stripe';

export const stripeService = {
  async getOrCreateCustomer(organizationId: string, email: string): Promise<string> {
    const stripe = getStripe();

    const [org] = await db
      .select({ stripeCustomerId: organizations.stripeCustomerId, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    if (org?.stripeCustomerId) {
      return org.stripeCustomerId;
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

  async handleWebhookEvent(payload: string, signature: string): Promise<void> {
    const stripe = getStripe();

    if (!env.STRIPE_WEBHOOK_SECRET) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }

    const event = stripe.webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const organizationId = session.metadata?.organizationId;
        const planType = session.metadata?.planType as PlanType | undefined;

        if (!organizationId || !planType) break;

        const subscriptionId = typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id;

        if (subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          await db
            .update(organizations)
            .set({
              plan: planType,
              stripeSubscriptionId: subscriptionId,
              stripeCurrentPeriodEnd: new Date((sub as any).current_period_end * 1000),
              updatedAt: new Date(),
            })
            .where(eq(organizations.id, organizationId));
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const organizationId = sub.metadata?.organizationId;

        if (!organizationId) break;

        const priceId = sub.items.data[0]?.price?.id;
        const newPlan = priceId ? getPlanFromPriceId(priceId) : null;

        const updateData: Record<string, unknown> = {
          stripeCurrentPeriodEnd: new Date((sub as any).current_period_end * 1000),
          updatedAt: new Date(),
        };

        if (newPlan) {
          updateData.plan = newPlan;
        }

        await db
          .update(organizations)
          .set(updateData)
          .where(eq(organizations.id, organizationId));
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const organizationId = sub.metadata?.organizationId;

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
        break;
      }

      case 'invoice.payment_failed': {
        // TODO: Send notification to org admin
        break;
      }
    }
  },
};
