import { describe, it, expect } from 'vitest';
import { addMonths, creditPeriod, remainingFraction, upgradeGrantCents, splitCharge } from './included-credit';

const d = (s: string) => new Date(s);

describe('creditPeriod', () => {
  it('monthly subscriptions use the Stripe period', () => {
    const p = creditPeriod('month', d('2026-09-15T10:00:00Z'), d('2026-10-15T10:00:00Z'), d('2026-09-29T00:00:00Z'));
    expect(p.key).toBe('2026-09-15');
    expect(p.end.toISOString()).toBe('2026-10-15T10:00:00.000Z');
  });

  it('yearly subscriptions get month-long slices from the renewal day', () => {
    const start = d('2026-01-31T12:00:00Z');
    const end = d('2027-01-31T12:00:00Z');
    expect(creditPeriod('year', start, end, d('2026-02-10T00:00:00Z')).key).toBe('2026-01-31');
    // Jan 31 + 1 month clamps to Feb 28
    const march = creditPeriod('year', start, end, d('2026-03-05T00:00:00Z'));
    expect(march.key).toBe('2026-02-28');
    expect(march.end.toISOString()).toBe('2026-03-31T12:00:00.000Z');
    const last = creditPeriod('year', start, end, d('2027-01-15T00:00:00Z'));
    expect(last.key).toBe('2026-12-31');
    expect(last.end.toISOString()).toBe(end.toISOString());
  });

  it('twelve distinct keys in a year', () => {
    const start = d('2026-05-10T00:00:00Z');
    const end = addMonths(start, 12);
    const keys = new Set<string>();
    for (let day = 0; day < 365; day += 3) {
      keys.add(creditPeriod('year', start, end, new Date(start.getTime() + day * 86400000)).key);
    }
    expect(keys.size).toBe(12);
  });
});

describe('upgradeGrantCents', () => {
  const p = { key: 'k', start: d('2026-09-01T00:00:00Z'), end: d('2026-10-01T00:00:00Z') };

  it('prorates the difference to the time left, like Stripe', () => {
    const f = remainingFraction(p, d('2026-09-16T00:00:00Z')); // 15 of 30 days left
    expect(upgradeGrantCents({ fromAmountCents: 900, toAmountCents: 4500, alreadyGrantedThisPeriodCents: 900, fractionRemaining: f })).toBe(1800);
  });

  it('closes the last-day upgrade hole', () => {
    const f = remainingFraction(p, d('2026-09-30T12:00:00Z'));
    expect(upgradeGrantCents({ fromAmountCents: 900, toAmountCents: 4500, alreadyGrantedThisPeriodCents: 900, fractionRemaining: f })).toBe(60);
  });

  it('never lifts the period total above the new plan, so down-then-up gains nothing', () => {
    // Hobby 900 granted, upgraded to Business at the start (+3600), downgraded, then upgraded again.
    expect(upgradeGrantCents({ fromAmountCents: 900, toAmountCents: 4500, alreadyGrantedThisPeriodCents: 4500, fractionRemaining: 1 })).toBe(0);
  });

  it('grants nothing on downgrades', () => {
    expect(upgradeGrantCents({ fromAmountCents: 4500, toAmountCents: 1800, alreadyGrantedThisPeriodCents: 4500, fractionRemaining: 1 })).toBe(0);
  });
});

describe('splitCharge', () => {
  it('spends included credit first', () => {
    expect(splitCharge(100, 60, 500)).toEqual({ fromIncludedCents: 60, fromWalletCents: 40 });
    expect(splitCharge(100, 900, 0)).toEqual({ fromIncludedCents: 100, fromWalletCents: 0 });
  });

  it('refuses when credit and wallet together fall short', () => {
    expect(splitCharge(100, 30, 50)).toBeNull();
  });
});
