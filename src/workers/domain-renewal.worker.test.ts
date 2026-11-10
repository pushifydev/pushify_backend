import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Every worker sweeps as soon as it starts, so two workers starting together must not both renew
 * a domain (two wallet debits, two registrar renewals). The tick holds a Postgres advisory lock;
 * a worker that cannot take it does nothing.
 */
const h = vi.hoisted(() => ({
  lockOk: true,
  queries: [] as string[],
  released: 0,
  selects: 0,
  debitWallet: vi.fn(),
  renew: vi.fn(),
  refund: vi.fn(),
  transferStatus: 'pending' as string,
  updates: [] as Record<string, unknown>[],
}));

vi.mock('../db', () => ({
  pool: {
    connect: async () => ({
      query: async (text: string) => {
        h.queries.push(text);
        if (text.includes('pg_try_advisory_lock')) return { rows: [{ ok: h.lockOk }] };
        return { rows: [{ pg_advisory_unlock: true }] };
      },
      release: () => {
        h.released++;
      },
    }),
  },
  db: {
    select: () => {
      h.selects++;
      return {
        from: () => ({
          // One active domain due in 10 days with auto-renew on; the transfer query sees it too
          // and gets `pending` back from the registrar, so it is left alone.
          where: () =>
            Object.assign(
              Promise.resolve([
                {
                  id: 'd1',
                  organizationId: 'org1',
                  domainName: 'example.com',
                  status: 'active',
                  autoRenew: true,
                  expiresAt: new Date('2026-11-18T00:00:00Z'),
                  renewalReminderSentAt: null,
                  renewalWholesaleCents: 1000,
                  wholesalePriceCents: 1000,
                },
              ]),
              { limit: async () => [{ name: 'Acme' }] }
            ),
        }),
      };
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        h.updates.push(values);
        return { where: async () => undefined };
      },
    }),
  },
}));
vi.mock('../lib/registrar', () => ({
  getRegistrar: () => ({
    getRenewalWholesaleCents: async () => 1000,
    renew: h.renew,
    getTransferStatus: async () => h.transferStatus,
  }),
}));
vi.mock('../lib/billing-notify', () => ({ resolveBillingNotifyEmail: async () => null }));
vi.mock('../services/admin-notify.service', () => ({ adminNotify: () => {} }));
vi.mock('../services/infra-billing.service', () => ({ infraBillingService: { debitWallet: h.debitWallet } }));
vi.mock('../services/registrar-domain.service', () => ({ refundDomainCharge: h.refund }));

import { runDomainSweeps, sweepPendingTransfers } from './domain-renewal.worker';

const NOW = new Date('2026-11-08T00:00:00Z');

beforeEach(() => {
  h.lockOk = true;
  h.queries = [];
  h.released = 0;
  h.selects = 0;
  h.debitWallet.mockReset().mockResolvedValue(5000);
  h.renew.mockReset().mockResolvedValue({ expiresAt: new Date('2027-11-18T00:00:00Z') });
  h.refund.mockReset().mockResolvedValue(undefined);
  h.transferStatus = 'pending';
  h.updates = [];
});

describe('runDomainSweeps lock', () => {
  it('skips the whole tick when another worker holds the lock', async () => {
    h.lockOk = false;
    expect(await runDomainSweeps(NOW)).toBeNull();
    expect(h.selects).toBe(0);
    expect(h.debitWallet).not.toHaveBeenCalled();
    expect(h.renew).not.toHaveBeenCalled();
    expect(h.queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(false);
    expect(h.released).toBe(1);
  });

  it('renews under the lock and releases it afterwards', async () => {
    expect(await runDomainSweeps(NOW)).toEqual({
      renewals: { renewed: 1, reminded: 0, expired: 0 },
      transfers: { completed: 0, failed: 0 },
    });
    expect(h.debitWallet).toHaveBeenCalledTimes(1);
    expect(h.renew).toHaveBeenCalledTimes(1);
    expect(h.queries).toHaveLength(2);
    expect(h.queries[0]).toContain('pg_try_advisory_lock');
    expect(h.queries[1]).toContain('pg_advisory_unlock');
    expect(h.released).toBe(1);
  });
});

describe('sweepPendingTransfers refund', () => {
  it('marks a cancelled transfer failed once the refund went through', async () => {
    h.transferStatus = 'cancelled';
    expect(await sweepPendingTransfers()).toEqual({ completed: 0, failed: 1 });
    expect(h.refund).toHaveBeenCalledTimes(1);
    expect(h.updates).toContainEqual(expect.objectContaining({ status: 'transfer_failed' }));
  });

  it('leaves the transfer pending when the refund fails so the next sweep retries it', async () => {
    h.transferStatus = 'cancelled';
    h.refund.mockRejectedValueOnce(new Error('db down'));
    expect(await sweepPendingTransfers()).toEqual({ completed: 0, failed: 0 });
    expect(h.refund).toHaveBeenCalledTimes(1);
    expect(h.updates).toEqual([]);

    // Next sweep: the refund succeeds and only then is the row marked failed.
    expect(await sweepPendingTransfers()).toEqual({ completed: 0, failed: 1 });
    expect(h.refund).toHaveBeenCalledTimes(2);
    expect(h.updates).toContainEqual(expect.objectContaining({ status: 'transfer_failed' }));
  });
});
