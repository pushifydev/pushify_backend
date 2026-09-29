import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';

vi.mock('../db', () => ({ db: {} }));
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({}),
  getPlanFromPriceId: (id: string) => ({ price_hobby: 'hobby', price_pro: 'pro', price_business: 'business' } as Record<string, string>)[id] ?? null,
}));

import { pendingChangeFromSchedule } from './plan-schedule.service';

const phase = (price: string, start: number, end: number, interval = 'month') => ({
  start_date: start,
  end_date: end,
  items: [{ price: { id: price, recurring: { interval } } }],
});
const schedule = (status: string, phases: unknown[]) => ({ id: 'sched_1', status, phases }) as unknown as Stripe.SubscriptionSchedule;
const NOW = 1_000_000;

describe('pendingChangeFromSchedule', () => {
  it('reads the next phase as the pending change, effective at the current phase end', () => {
    const p = pendingChangeFromSchedule(schedule('active', [phase('price_business', NOW - 10, NOW + 100), phase('price_hobby', NOW + 100, NOW + 200)]), NOW);
    expect(p).toMatchObject({ plan: 'hobby', interval: 'month', scheduleId: 'sched_1' });
    expect(p?.effectiveAt.getTime()).toBe((NOW + 100) * 1000);
  });

  it('a schedule edited in Stripe to another plan is followed', () => {
    const p = pendingChangeFromSchedule(schedule('active', [phase('price_business', NOW - 10, NOW + 100), phase('price_pro', NOW + 100, NOW + 200)]), NOW);
    expect(p?.plan).toBe('pro');
  });

  it('nothing is pending when the next phase keeps the same price', () => {
    expect(pendingChangeFromSchedule(schedule('active', [phase('price_pro', NOW - 10, NOW + 100), phase('price_pro', NOW + 100, NOW + 200)]), NOW)).toBeNull();
  });

  it('released, cancelled or completed schedules have nothing pending', () => {
    const phases = [phase('price_business', NOW - 10, NOW + 100), phase('price_hobby', NOW + 100, NOW + 200)];
    for (const status of ['released', 'canceled', 'completed']) {
      expect(pendingChangeFromSchedule(schedule(status, phases), NOW)).toBeNull();
    }
  });

  it('an unknown price is not treated as a plan change', () => {
    expect(pendingChangeFromSchedule(schedule('active', [phase('price_business', NOW - 10, NOW + 100), phase('price_other', NOW + 100, NOW + 200)]), NOW)).toBeNull();
  });
});
