import { describe, it, expect, vi, beforeEach } from 'vitest';

/** A past_due flag is re-checked against the whole Stripe customer before it blocks the organisation. */

type Org = { id: string; billingStatus: string; stripeCustomerId: string | null; stripeSubscriptionId: string | null };

const h = vi.hoisted(() => ({
  org: null as null | Org,
  updates: [] as Record<string, unknown>[],
  subs: vi.fn(),
  invoices: vi.fn(),
}));

vi.mock('../config/env', () => ({ env: { STRIPE_SECRET_KEY: 'sk_test_x' } }));
vi.mock('../db', () => ({
  db: {
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: async () => {
          h.updates.push(data);
        },
      }),
    }),
  },
}));
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: { findById: async () => h.org },
}));
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({ subscriptions: { list: h.subs }, invoices: { list: h.invoices } }),
  getPlanFromPriceId: (id: string) => (id === 'price_pro' ? 'pro' : null),
}));
vi.mock('../repositories/project.repository', () => ({ projectRepository: {} }));
vi.mock('../providers', () => ({ createProvider: vi.fn() }));
vi.mock('../lib/email', () => ({ sendBillingPaymentFailedEmail: vi.fn(), sendBillingSuspendedEmail: vi.fn() }));
vi.mock('../lib/billing-notify', () => ({ resolveBillingNotifyEmail: vi.fn() }));
vi.mock('../lib/project-remote-cleanup', () => ({ pauseProjectContainers: vi.fn() }));
vi.mock('../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  assertOrganizationCanMutateResources,
  getOrganizationBillingStatus,
  reconcilePastDue,
} from './organization-billing.service';

const sub = (id: string, status: string, created = 1) => ({
  id,
  status,
  created,
  items: { data: [{ price: { id: 'price_pro' } }] },
});

let n = 0;
const pastDueOrg = (linked: string | null = 'sub_new'): Org => ({
  id: `org_${++n}`, // a fresh id per test: the negative-result cache is per organisation
  billingStatus: 'past_due',
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: linked,
});

beforeEach(() => {
  h.updates = [];
  h.subs.mockReset();
  h.invoices.mockReset().mockResolvedValue({ data: [] });
});

describe('past_due reconcile', () => {
  it('clears past_due when the linked subscription is active', async () => {
    h.org = pastDueOrg();
    h.subs.mockResolvedValue({ data: [sub('sub_new', 'active')] });

    await expect(assertOrganizationCanMutateResources(h.org.id, 'en')).resolves.toBeUndefined();
    expect(h.updates[0]).toMatchObject({ billingStatus: 'active', stripeSubscriptionId: 'sub_new', plan: 'pro' });
  });

  it('links a newer active subscription when the linked one is an old unpaid one', async () => {
    h.org = pastDueOrg('sub_old');
    h.subs.mockResolvedValue({ data: [sub('sub_old', 'past_due', 1), sub('sub_new', 'active', 2)] });

    await expect(getOrganizationBillingStatus(h.org.id)).resolves.toBe('active');
    expect(h.updates[0]).toMatchObject({ billingStatus: 'active', stripeSubscriptionId: 'sub_new' });
  });

  it('clears past_due when no subscription was ever linked but one is active', async () => {
    h.org = pastDueOrg(null);
    h.subs.mockResolvedValue({ data: [sub('sub_new', 'active')] });

    await expect(getOrganizationBillingStatus(h.org.id)).resolves.toBe('active');
    expect(h.updates[0]).toMatchObject({ stripeSubscriptionId: 'sub_new' });
  });

  it('clears past_due when nothing is live and nothing is owed', async () => {
    h.org = pastDueOrg();
    h.subs.mockResolvedValue({ data: [sub('sub_new', 'canceled')] });

    await expect(getOrganizationBillingStatus(h.org.id)).resolves.toBe('active');
    expect(h.updates[0]).toMatchObject({ billingStatus: 'active' });
  });

  it('keeps blocking when the subscription really is past due', async () => {
    h.org = pastDueOrg();
    h.subs.mockResolvedValue({ data: [sub('sub_new', 'past_due')] });

    await expect(assertOrganizationCanMutateResources(h.org.id, 'en')).rejects.toMatchObject({ status: 402 });
    expect(h.updates).toEqual([]);
  });

  it('keeps blocking while an invoice is open', async () => {
    h.org = pastDueOrg();
    h.subs.mockResolvedValue({ data: [sub('sub_new', 'canceled')] });
    h.invoices.mockResolvedValue({ data: [{ id: 'in_1' }] });

    await expect(getOrganizationBillingStatus(h.org.id)).resolves.toBe('past_due');
  });

  it('asks Stripe once a minute for an organisation that owes, unless forced', async () => {
    const org = pastDueOrg();
    h.subs.mockResolvedValue({ data: [sub('sub_new', 'past_due')] });

    await reconcilePastDue(org);
    await reconcilePastDue(org);
    expect(h.subs).toHaveBeenCalledTimes(1);
    await reconcilePastDue(org, { force: true });
    expect(h.subs).toHaveBeenCalledTimes(2);
  });

  it('keeps blocking when Stripe cannot be reached', async () => {
    h.org = pastDueOrg();
    h.subs.mockRejectedValue(new Error('network'));

    await expect(getOrganizationBillingStatus(h.org.id)).resolves.toBe('past_due');
  });

  it('does not call Stripe for an active organisation', async () => {
    h.org = { ...pastDueOrg(), billingStatus: 'active' };

    await expect(getOrganizationBillingStatus(h.org.id)).resolves.toBe('active');
    expect(h.subs).not.toHaveBeenCalled();
  });
});
