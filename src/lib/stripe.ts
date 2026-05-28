import Stripe from 'stripe';
import { env } from '../config/env';
import type { PlanType } from './plans';

let stripeInstance: Stripe | null = null;

export function getStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  if (!stripeInstance) {
    stripeInstance = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-02-25.clover',
      typescript: true,
    });
  }
  return stripeInstance;
}

// Map plan types to Stripe Price IDs (set these from your Stripe Dashboard)
// Format: { monthly: 'price_xxx', yearly: 'price_yyy' }
export const STRIPE_PRICE_IDS: Record<PlanType, { monthly: string; yearly: string } | null> = {
  free: null,
  hobby: {
    monthly: 'price_1TDiioC34JPtjVa9kZjFTYVF',
    yearly: 'price_1TDiioC34JPtjVa9kZjFTYVF', // Uses monthly price until yearly is created in Stripe
  },
  pro: {
    monthly: 'price_1TDijQC34JPtjVa9IfxvjlPe',
    yearly: 'price_1TDijQC34JPtjVa9IfxvjlPe',
  },
  business: {
    monthly: 'price_1TDijkC34JPtjVa9L0znYUAB',
    yearly: 'price_1TDijkC34JPtjVa9L0znYUAB',
  },
  enterprise: null,
};

export function getPriceId(plan: PlanType, cycle: 'monthly' | 'yearly'): string | null {
  const prices = STRIPE_PRICE_IDS[plan];
  if (!prices) return null;
  return prices[cycle] || null;
}

// Reverse lookup: find plan type from Stripe Price ID
export function getPlanFromPriceId(priceId: string): PlanType | null {
  for (const [plan, prices] of Object.entries(STRIPE_PRICE_IDS)) {
    if (!prices) continue;
    if (prices.monthly === priceId || prices.yearly === priceId) {
      return plan as PlanType;
    }
  }
  return null;
}

/**
 * Stripe API 2025+ moved billing period fields onto subscription items.
 * Webhooks may omit top-level current_period_end on the subscription object.
 */
export function getSubscriptionCurrentPeriodEnd(sub: Stripe.Subscription): Date | null {
  const legacyEnd = (sub as Stripe.Subscription & { current_period_end?: number }).current_period_end;
  if (typeof legacyEnd === 'number' && Number.isFinite(legacyEnd)) {
    return new Date(legacyEnd * 1000);
  }

  for (const item of sub.items?.data ?? []) {
    const itemEnd = (item as Stripe.SubscriptionItem & { current_period_end?: number }).current_period_end;
    if (typeof itemEnd === 'number' && Number.isFinite(itemEnd)) {
      return new Date(itemEnd * 1000);
    }
  }

  return null;
}

export function getOrganizationIdFromSubscription(sub: Stripe.Subscription): string | null {
  const fromMeta = sub.metadata?.organizationId;
  if (fromMeta) return fromMeta;
  return null;
}
