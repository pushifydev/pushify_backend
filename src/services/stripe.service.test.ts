import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

/**
 * Duplicate-subscription guards:
 *  - checkout must refuse to open a second subscription while one is still live;
 *  - subscription.updated/deleted for a subscription that is NOT the org's current one must
 *    not fall back to metadata (it would downgrade/suspend an org with an active subscription).
 */

const h = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  updates: [] as Record<string, unknown>[],
  stripe: {
    subscriptions: { retrieve: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    customers: { retrieve: vi.fn(), create: vi.fn() },
  },
  suspendOrganization: vi.fn(),
}));

vi.mock('../db', () => {
  const selectChain = () => {
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: async () => h.selectResults.shift() ?? [],
    };
    return chain;
  };
  return {
    db: {
      select: () => selectChain(),
      update: () => ({
        set: (data: Record<string, unknown>) => ({
          where: async () => {
            h.updates.push(data);
          },
        }),
      }),
    },
  };
});

vi.mock('../lib/stripe', () => ({
  getStripe: () => h.stripe,
  getPriceId: () => 'price_pro_monthly',
  getPlanFromPriceId: (id: string) => (id === 'price_hobby' ? 'hobby' : id === 'price_pro' ? 'pro' : null),
  getSubscriptionCurrentPeriodEnd: () => null,
  getOrganizationIdFromSubscription: (sub: Stripe.Subscription) => sub.metadata?.organizationId ?? null,
}));

vi.mock('../lib/stripe-webhook-dedupe', () => ({
  claimStripeWebhookEvent: vi.fn(),
  releaseStripeWebhookEvent: vi.fn(),
}));
vi.mock('../lib/email', () => ({
  sendBillingPlanActivatedEmail: vi.fn(),
  sendInfraCreditTopUpEmail: vi.fn(),
}));
vi.mock('../lib/billing-notify', () => ({ resolveBillingNotifyEmail: vi.fn() }));
vi.mock('../repositories/organization.repository', () => ({ organizationRepository: { findById: vi.fn() } }));
vi.mock('./infra-billing.service', () => ({ infraBillingService: {} }));
vi.mock('./organization-billing.service', () => ({
  organizationBillingService: { suspendOrganization: h.suspendOrganization },
}));
vi.mock('./admin-notify.service', () => ({ adminNotify: vi.fn() }));
vi.mock('../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { stripeService } from './stripe.service';

const ORG = 'org_1';

beforeEach(() => {
  h.selectResults = [];
  h.updates = [];
  vi.clearAllMocks();
  h.stripe.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.test/s' });
  h.stripe.customers.retrieve.mockResolvedValue({ id: 'cus_1' });
});

const checkout = () => stripeService.createCheckoutSession(ORG, 'user_1', 'a@b.c', 'pro', 'monthly');

describe('createCheckoutSession', () => {
  it.each(['active', 'trialing', 'past_due'])('refuses when the current subscription is %s', async (status) => {
    h.selectResults.push([{ stripeSubscriptionId: 'sub_old' }]);
    h.stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_old', status });

    await expect(checkout()).rejects.toThrow('SUBSCRIPTION_EXISTS');
    expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('allows checkout when the stored subscription is canceled', async () => {
    h.selectResults.push([{ stripeSubscriptionId: 'sub_old' }], [{ stripeCustomerId: 'cus_1', name: 'Org' }]);
    h.stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_old', status: 'canceled' });

    await expect(checkout()).resolves.toBe('https://checkout.stripe.test/s');
  });

  it('allows checkout when the stored subscription no longer exists in Stripe', async () => {
    h.selectResults.push([{ stripeSubscriptionId: 'sub_gone' }], [{ stripeCustomerId: 'cus_1', name: 'Org' }]);
    h.stripe.subscriptions.retrieve.mockRejectedValue({ code: 'resource_missing' });

    await expect(checkout()).resolves.toBe('https://checkout.stripe.test/s');
  });

  it('allows checkout when the org has no subscription', async () => {
    h.selectResults.push([{ stripeSubscriptionId: null }], [{ stripeCustomerId: 'cus_1', name: 'Org' }]);

    await expect(checkout()).resolves.toBe('https://checkout.stripe.test/s');
    expect(h.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });
});

const subEvent = (type: string, sub: Partial<Stripe.Subscription>) =>
  ({ id: 'evt_1', type, data: { object: sub } }) as unknown as Stripe.Event;

const oldSub = {
  id: 'sub_old',
  status: 'canceled',
  metadata: { organizationId: ORG },
  items: { data: [{ price: { id: 'price_hobby' } }] },
} as unknown as Stripe.Subscription;

const runEvent = (event: Stripe.Event) =>
  stripeService.processWebhookEvent(event, h.stripe as unknown as Stripe);

describe('subscription webhooks for a non-current subscription', () => {
  it('subscription.deleted does not downgrade or suspend an org linked to another subscription', async () => {
    // lookup by sub id → none; lookup by metadata org → linked to sub_new
    h.selectResults.push([], [{ stripeSubscriptionId: 'sub_new' }]);

    await runEvent(subEvent('customer.subscription.deleted', oldSub));

    expect(h.updates).toEqual([]);
    expect(h.suspendOrganization).not.toHaveBeenCalled();
  });

  it('subscription.updated does not rewrite plan / subscription id from another subscription', async () => {
    h.selectResults.push([], [{ stripeSubscriptionId: 'sub_new' }]);

    await runEvent(subEvent('customer.subscription.updated', { ...oldSub, status: 'active' }));

    expect(h.updates).toEqual([]);
  });

  it('subscription.deleted still falls back to metadata when the org has no linked subscription', async () => {
    h.selectResults.push([], [{ stripeSubscriptionId: null }]);

    await runEvent(subEvent('customer.subscription.deleted', oldSub));

    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ plan: 'free', stripeSubscriptionId: null });
    expect(h.suspendOrganization).toHaveBeenCalledWith(ORG);
  });

  it('subscription.deleted for the current subscription suspends the org', async () => {
    h.selectResults.push([{ id: ORG }]);

    await runEvent(subEvent('customer.subscription.deleted', oldSub));

    expect(h.updates[0]).toMatchObject({ plan: 'free' });
    expect(h.suspendOrganization).toHaveBeenCalledWith(ORG);
  });

  it('subscription.updated for the current subscription updates the plan', async () => {
    h.selectResults.push([{ id: ORG }]);

    await runEvent(subEvent('customer.subscription.updated', { ...oldSub, status: 'active' }));

    expect(h.updates[0]).toMatchObject({ plan: 'hobby', stripeSubscriptionId: 'sub_old', billingStatus: 'active' });
  });
});
