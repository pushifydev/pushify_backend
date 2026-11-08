import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The hourly charge debits the wallet and moves `infraLastChargedAt` in separate steps, so two
 * workers reading the same anchor would bill the same time twice. The run holds a Postgres
 * advisory lock; a worker that cannot take it reads and charges nothing.
 */
const h = vi.hoisted(() => ({
  lockOk: true,
  queries: [] as string[],
  released: 0,
  selects: 0,
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
      return { from: () => ({ where: async () => [] }) };
    },
  },
}));

import { infraBillingService } from './infra-billing.service';

beforeEach(() => {
  h.lockOk = true;
  h.queries = [];
  h.released = 0;
  h.selects = 0;
});

describe('infraBillingService.processHourlyBilling lock', () => {
  it('skips the run when another worker holds the lock', async () => {
    h.lockOk = false;
    const debit = vi.spyOn(infraBillingService, 'debitWallet');
    expect(await infraBillingService.processHourlyBilling()).toEqual({ charged: 0, stopped: 0, skipped: 0 });
    expect(h.selects).toBe(0);
    expect(debit).not.toHaveBeenCalled();
    expect(h.queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(false);
    expect(h.released).toBe(1);
  });

  it('bills under the lock and releases it afterwards', async () => {
    expect(await infraBillingService.processHourlyBilling()).toEqual({ charged: 0, stopped: 0, skipped: 0 });
    expect(h.selects).toBe(1);
    expect(h.queries).toHaveLength(2);
    expect(h.queries[0]).toContain('pg_try_advisory_lock');
    expect(h.queries[1]).toContain('pg_advisory_unlock');
    expect(h.released).toBe(1);
  });
});
