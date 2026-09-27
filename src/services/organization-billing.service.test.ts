import { describe, it, expect, vi, beforeEach } from 'vitest';

/** A stale past_due flag is re-checked against Stripe before it blocks the organisation. */

const h = vi.hoisted(() => ({
  org: null as null | { billingStatus: string; stripeSubscriptionId: string | null },
  updates: [] as Record<string, unknown>[],
  retrieve: vi.fn(),
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
vi.mock('../lib/stripe', () => ({ getStripe: () => ({ subscriptions: { retrieve: h.retrieve } }) }));
vi.mock('../repositories/project.repository', () => ({ projectRepository: {} }));
vi.mock('../providers', () => ({ createProvider: vi.fn() }));
vi.mock('../lib/email', () => ({ sendBillingPaymentFailedEmail: vi.fn(), sendBillingSuspendedEmail: vi.fn() }));
vi.mock('../lib/billing-notify', () => ({ resolveBillingNotifyEmail: vi.fn() }));
vi.mock('../lib/project-remote-cleanup', () => ({ pauseProjectContainers: vi.fn() }));
vi.mock('../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { assertOrganizationCanMutateResources, getOrganizationBillingStatus } from './organization-billing.service';

beforeEach(() => {
  h.updates = [];
  h.retrieve.mockReset();
});

describe('past_due reconcile', () => {
  it('clears past_due when Stripe reports the current subscription active', async () => {
    h.org = { billingStatus: 'past_due', stripeSubscriptionId: 'sub_new' };
    h.retrieve.mockResolvedValue({ id: 'sub_new', status: 'active' });

    await expect(assertOrganizationCanMutateResources('org_1', 'en')).resolves.toBeUndefined();
    expect(h.updates[0]).toMatchObject({ billingStatus: 'active' });
  });

  it('keeps blocking when the subscription is really past due', async () => {
    h.org = { billingStatus: 'past_due', stripeSubscriptionId: 'sub_new' };
    h.retrieve.mockResolvedValue({ id: 'sub_new', status: 'past_due' });

    await expect(assertOrganizationCanMutateResources('org_1', 'en')).rejects.toMatchObject({ status: 402 });
    expect(h.updates).toEqual([]);
  });

  it('keeps blocking when Stripe cannot be reached', async () => {
    h.org = { billingStatus: 'past_due', stripeSubscriptionId: 'sub_new' };
    h.retrieve.mockRejectedValue(new Error('network'));

    await expect(getOrganizationBillingStatus('org_1')).resolves.toBe('past_due');
  });

  it('does not call Stripe for an active organisation', async () => {
    h.org = { billingStatus: 'active', stripeSubscriptionId: 'sub_new' };

    await expect(getOrganizationBillingStatus('org_1')).resolves.toBe('active');
    expect(h.retrieve).not.toHaveBeenCalled();
  });
});
