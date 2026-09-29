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
  /** What Stripe says now, by id. Unset ids fall back to the event's own object. */
  live: {} as Record<string, unknown>,
  stripe: {
    subscriptions: { retrieve: vi.fn() },
    invoices: { retrieve: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    customers: { retrieve: vi.fn(), create: vi.fn() },
  },
  suspendOrganization: vi.fn(),
  markPastDue: vi.fn(),
  markActive: vi.fn(),
  notifyPaymentFailedIfDue: vi.fn(),
  planSchedule: { syncFromSchedule: vi.fn(), reconcileFromSubscription: vi.fn(), releasePending: vi.fn(), scheduleChange: vi.fn() },
  includedCredit: {
    currentPlan: vi.fn(),
    ensurePeriodGrant: vi.fn(),
    grantUpgradeDifference: vi.fn(),
    expire: vi.fn(),
  },
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
  getSubscriptionPeriod: () => null,
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
vi.mock('./included-credit.service', () => ({ includedCreditService: h.includedCredit }));
vi.mock('./plan-schedule.service', () => ({ planScheduleService: h.planSchedule }));
vi.mock('./organization-billing.service', () => ({
  organizationBillingService: {
    suspendOrganization: h.suspendOrganization,
    markPastDue: h.markPastDue,
    markActive: h.markActive,
    notifyPaymentFailedIfDue: h.notifyPaymentFailedIfDue,
  },
  getOrganizationBillingStatus: vi.fn(),
}));
vi.mock('./admin-notify.service', () => ({ adminNotify: vi.fn() }));
vi.mock('../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { stripeService } from './stripe.service';

const ORG = 'org_1';

beforeEach(() => {
  h.live = {};
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

const runEvent = (event: Stripe.Event) => {
  const obj = event.data.object as { id?: string };
  const byType: Record<string, unknown> = event.type.startsWith('invoice.')
    ? { ...obj, status: event.type === 'invoice.paid' ? 'paid' : 'open' }
    : obj;
  const fallback = (id: string) => (id in h.live ? h.live[id] : id === obj.id ? byType : undefined);
  h.stripe.subscriptions.retrieve.mockImplementation(async (id: string) => {
    const v = fallback(id);
    if (v === null) throw Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 });
    return v;
  });
  h.stripe.invoices.retrieve.mockImplementation(async (id: string) => fallback(id));
  return stripeService.processWebhookEvent(event, h.stripe as unknown as Stripe);
};

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

const invoiceEvent = (type: string, subscriptionId: string | null) =>
  ({
    id: 'evt_inv',
    type,
    data: {
      object: {
        id: 'in_1',
        customer: 'cus_1',
        hosted_invoice_url: 'https://invoice.stripe.test/i',
        parent: subscriptionId ? { subscription_details: { subscription: subscriptionId } } : null,
      },
    },
  }) as unknown as Stripe.Event;

const paidOrg = { id: ORG, name: 'Org', plan: 'pro', stripeSubscriptionId: 'sub_new' };

describe('invoice webhooks for an older subscription', () => {
  it('a failed invoice of an older subscription does not mark a paid-up org past due', async () => {
    h.selectResults.push([paidOrg]);

    await runEvent(invoiceEvent('invoice.payment_failed', 'sub_old'));

    expect(h.markPastDue).not.toHaveBeenCalled();
    expect(h.notifyPaymentFailedIfDue).not.toHaveBeenCalled();
  });

  it('a failed invoice of the current subscription marks the org past due', async () => {
    h.selectResults.push([paidOrg]);

    await runEvent(invoiceEvent('invoice.payment_failed', 'sub_new'));

    expect(h.markPastDue).toHaveBeenCalledWith(ORG);
    expect(h.notifyPaymentFailedIfDue).toHaveBeenCalledWith(ORG, 'Org', 'https://invoice.stripe.test/i', 'failed');
  });

  it('a paid invoice of an older subscription does not clear past due', async () => {
    h.selectResults.push([paidOrg]);

    await runEvent(invoiceEvent('invoice.paid', 'sub_old'));

    expect(h.markActive).not.toHaveBeenCalled();
  });

  it('a paid invoice of the current subscription clears past due', async () => {
    h.selectResults.push([paidOrg]);

    await runEvent(invoiceEvent('invoice.paid', 'sub_new'));

    expect(h.markActive).toHaveBeenCalledWith(ORG);
  });
});

describe('included server credit on subscription events', () => {
  const sub = (priceId: string, status = 'active') =>
    ({ id: 'sub_old', status, metadata: { organizationId: ORG }, items: { data: [{ price: { id: priceId } }] } }) as unknown as Stripe.Subscription;

  it('a pending upgrade applied by subscription.updated adds the prorated difference', async () => {
    h.selectResults.push([{ id: ORG }]);
    h.includedCredit.currentPlan.mockResolvedValue('hobby');

    await runEvent(subEvent('customer.subscription.updated', sub('price_pro')));

    expect(h.includedCredit.grantUpgradeDifference).toHaveBeenCalledWith(ORG, 'hobby', 'pro');
  });

  it('a downgrade by subscription.updated grants nothing', async () => {
    h.selectResults.push([{ id: ORG }]);
    h.includedCredit.currentPlan.mockResolvedValue('pro');

    await runEvent(subEvent('customer.subscription.updated', sub('price_hobby')));

    expect(h.includedCredit.grantUpgradeDifference).not.toHaveBeenCalled();
  });

  it('an upgrade on a past_due subscription grants nothing until it is paid', async () => {
    h.selectResults.push([{ id: ORG }]);
    h.includedCredit.currentPlan.mockResolvedValue('hobby');

    await runEvent(subEvent('customer.subscription.updated', sub('price_pro', 'past_due')));

    expect(h.includedCredit.grantUpgradeDifference).not.toHaveBeenCalled();
  });

  it('subscription.deleted expires what is left of the credit', async () => {
    h.selectResults.push([{ id: ORG }]);

    await runEvent(subEvent('customer.subscription.deleted', sub('price_pro', 'canceled')));

    expect(h.includedCredit.expire).toHaveBeenCalledWith(ORG, 'canceled');
  });

  it('a paid invoice of the current subscription checks the period grant', async () => {
    h.selectResults.push([paidOrg]);

    await runEvent(invoiceEvent('invoice.paid', 'sub_new'));

    expect(h.includedCredit.ensurePeriodGrant).toHaveBeenCalledWith(ORG);
  });

  it('a paid invoice of an older subscription grants nothing', async () => {
    h.selectResults.push([paidOrg]);

    await runEvent(invoiceEvent('invoice.paid', 'sub_old'));

    expect(h.includedCredit.ensurePeriodGrant).not.toHaveBeenCalled();
  });
});

describe('subscription schedule events', () => {
  for (const type of ['created', 'updated', 'released', 'canceled', 'completed', 'aborted']) {
    it(`subscription_schedule.${type} re-syncs the pending change`, async () => {
      const schedule = { id: 'sub_sched_1', status: 'active', subscription: 'sub_new', phases: [] };
      await runEvent({ id: `evt_${type}`, type: `subscription_schedule.${type}`, data: { object: schedule } } as unknown as Stripe.Event);
      expect(h.planSchedule.syncFromSchedule).toHaveBeenCalledWith(schedule);
    });
  }

  it('subscription.deleted clears any pending change', async () => {
    h.selectResults.push([{ id: ORG }]);
    await runEvent(subEvent('customer.subscription.deleted', oldSub));
    expect(h.planSchedule.reconcileFromSubscription).toHaveBeenCalledWith(ORG, null);
  });
});

describe('late or out-of-order events act on what Stripe says now', () => {
  const sub = (priceId: string, status = 'active') =>
    ({ id: 'sub_old', status, metadata: { organizationId: ORG }, items: { data: [{ price: { id: priceId } }] } }) as unknown as Stripe.Subscription;

  it('a stale subscription.updated (Hobby) does not undo a newer plan (Pro)', async () => {
    h.selectResults.push([{ id: ORG }]);
    h.live.sub_old = sub('price_pro');
    h.includedCredit.currentPlan.mockResolvedValue('pro');

    await runEvent(subEvent('customer.subscription.updated', sub('price_hobby')));

    expect(h.updates[0]).toMatchObject({ plan: 'pro' });
    expect(h.includedCredit.grantUpgradeDifference).not.toHaveBeenCalled();
  });

  it('a stale Hobby → Pro event does not grant upgrade credit when Stripe still bills Hobby', async () => {
    h.selectResults.push([{ id: ORG }]);
    h.live.sub_old = sub('price_hobby');
    h.includedCredit.currentPlan.mockResolvedValue('hobby');

    await runEvent(subEvent('customer.subscription.updated', sub('price_pro')));

    expect(h.updates[0]).toMatchObject({ plan: 'hobby' });
    expect(h.includedCredit.grantUpgradeDifference).not.toHaveBeenCalled();
  });

  it('subscription.updated after the subscription ended changes nothing', async () => {
    h.selectResults.push([{ id: ORG }]);
    h.live.sub_old = sub('price_pro', 'canceled');

    await runEvent(subEvent('customer.subscription.updated', sub('price_pro')));

    expect(h.updates).toHaveLength(0);
    expect(h.includedCredit.ensurePeriodGrant).not.toHaveBeenCalled();
  });

  it('subscription.deleted for a subscription that is still live does not downgrade or expire credit', async () => {
    h.selectResults.push([{ id: ORG }]);
    h.live.sub_old = sub('price_pro', 'active');

    await runEvent(subEvent('customer.subscription.deleted', sub('price_pro', 'canceled')));

    expect(h.updates).toHaveLength(0);
    expect(h.suspendOrganization).not.toHaveBeenCalled();
    expect(h.includedCredit.expire).not.toHaveBeenCalled();
  });

  it('subscription.deleted for a subscription Stripe no longer has still ends it', async () => {
    h.selectResults.push([{ id: ORG }]);
    h.live.sub_old = null;

    await runEvent(subEvent('customer.subscription.deleted', sub('price_pro', 'canceled')));

    expect(h.updates[0]).toMatchObject({ plan: 'free' });
    expect(h.includedCredit.expire).toHaveBeenCalledWith(ORG, 'canceled');
  });

  it('a late payment_failed for an invoice paid since does not mark the org past due', async () => {
    h.selectResults.push([paidOrg]);
    h.live.in_1 = { id: 'in_1', status: 'paid' };

    await runEvent(invoiceEvent('invoice.payment_failed', 'sub_new'));

    expect(h.markPastDue).not.toHaveBeenCalled();
  });

  it('invoice.paid for an invoice voided since grants nothing', async () => {
    h.selectResults.push([paidOrg]);
    h.live.in_1 = { id: 'in_1', status: 'void' };

    await runEvent(invoiceEvent('invoice.paid', 'sub_new'));

    expect(h.markActive).not.toHaveBeenCalled();
    expect(h.includedCredit.ensurePeriodGrant).not.toHaveBeenCalled();
  });
});
