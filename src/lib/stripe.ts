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

const DEFAULT_STRIPE_PRICE_IDS: Record<PlanType, { monthly: string; yearly: string } | null> = {
  free: null,
  hobby: {
    monthly: 'price_1TDiioC34JPtjVa9kZjFTYVF',
    yearly: 'price_1TDiioC34JPtjVa9kZjFTYVF',
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

function priceFromEnv(monthly?: string, yearly?: string): { monthly: string; yearly: string } | null {
  if (!monthly) return null;
  return { monthly, yearly: yearly || monthly };
}

/** Plan → Stripe Price IDs (env overrides defaults for production) */
export const STRIPE_PRICE_IDS: Record<PlanType, { monthly: string; yearly: string } | null> = {
  free: null,
  hobby:
    priceFromEnv(env.STRIPE_PRICE_HOBBY_MONTHLY, env.STRIPE_PRICE_HOBBY_YEARLY) ??
    DEFAULT_STRIPE_PRICE_IDS.hobby,
  pro:
    priceFromEnv(env.STRIPE_PRICE_PRO_MONTHLY, env.STRIPE_PRICE_PRO_YEARLY) ??
    DEFAULT_STRIPE_PRICE_IDS.pro,
  business:
    priceFromEnv(env.STRIPE_PRICE_BUSINESS_MONTHLY, env.STRIPE_PRICE_BUSINESS_YEARLY) ??
    DEFAULT_STRIPE_PRICE_IDS.business,
  enterprise: null,
};

function parseLegacyIds(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Retired price IDs (post-repricing) that must still resolve to a plan in webhooks */
const LEGACY_PRICE_IDS: Partial<Record<PlanType, string[]>> = {
  hobby: parseLegacyIds(env.STRIPE_PRICE_HOBBY_LEGACY),
  pro: parseLegacyIds(env.STRIPE_PRICE_PRO_LEGACY),
  business: parseLegacyIds(env.STRIPE_PRICE_BUSINESS_LEGACY),
};

export function getPriceId(plan: PlanType, cycle: 'monthly' | 'yearly'): string | null {
  const prices = STRIPE_PRICE_IDS[plan];
  if (!prices) return null;
  return prices[cycle] || null;
}

export function getPlanFromPriceId(priceId: string): PlanType | null {
  for (const [plan, prices] of Object.entries(STRIPE_PRICE_IDS)) {
    if (!prices) continue;
    if (prices.monthly === priceId || prices.yearly === priceId) {
      return plan as PlanType;
    }
  }
  // Fall back to retired price IDs: when env vars point at NEW prices after a
  // repricing, webhooks for subscribers still on the old prices must keep resolving
  // to their plan — otherwise a renewal would silently drop them to null.
  for (const [plan, ids] of Object.entries(LEGACY_PRICE_IDS)) {
    if (ids?.includes(priceId)) return plan as PlanType;
  }
  for (const [plan, prices] of Object.entries(DEFAULT_STRIPE_PRICE_IDS)) {
    if (!prices) continue;
    if (prices.monthly === priceId || prices.yearly === priceId) {
      return plan as PlanType;
    }
  }
  return null;
}

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
