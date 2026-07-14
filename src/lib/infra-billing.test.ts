import { describe, it, expect } from 'vitest';
import { accrueInfraCharge, minimumBalanceToStartCents, HOURS_PER_MONTH } from './infra-billing';

const HOUR_MS = 3600 * 1000;

/**
 * Regression: the integer hourly price was derived with round-then-ceil, inflating small
 * servers' rate (0.65¢/h → 2¢/h ≈ 2.5× overcharge — a month of credits burned in ~15 days).
 * Billing now accrues from the MONTHLY price with millicent carry.
 */
describe('accrueInfraCharge', () => {
  it('a full month of hourly ticks bills exactly the monthly price (±1 cent)', () => {
    const monthly = 575; // ~$5.75/mo — the class of small server that was overcharged
    let carry = 0;
    let total = 0;
    for (let h = 0; h < HOURS_PER_MONTH; h++) {
      const r = accrueInfraCharge(monthly, HOUR_MS, carry);
      total += r.chargeCents;
      carry = r.carryMillicents;
    }
    expect(Math.abs(total - monthly)).toBeLessThanOrEqual(1);
    // The old bug billed ceil(round(0.65)·1.2)=2¢ × 730 = 1460¢ for this server.
    expect(total).toBeLessThan(600);
  });

  it('carry stays within [0, 1000) millicents', () => {
    let carry = 0;
    for (let h = 0; h < 100; h++) {
      const r = accrueInfraCharge(575, HOUR_MS, carry);
      carry = r.carryMillicents;
      expect(carry).toBeGreaterThanOrEqual(0);
      expect(carry).toBeLessThan(1000);
    }
  });

  it('irregular tick intervals bill the same total as regular ones', () => {
    const monthly = 1234;
    const day = 24 * HOUR_MS;
    // one 24h accrual...
    const single = accrueInfraCharge(monthly, day, 0);
    // ...vs 24 × 1h accruals
    let carry = 0;
    let total = 0;
    for (let h = 0; h < 24; h++) {
      const r = accrueInfraCharge(monthly, HOUR_MS, carry);
      total += r.chargeCents;
      carry = r.carryMillicents;
    }
    expect(Math.abs(single.chargeCents - (total + Math.round(carry / 1000)))).toBeLessThanOrEqual(1);
  });

  it('worker restarts (extra short accruals) do not inflate the total', () => {
    const monthly = 575;
    // 10 restarts in an hour: ten 6-minute accruals
    let carry = 0;
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const r = accrueInfraCharge(monthly, HOUR_MS / 10, carry);
      total += r.chargeCents;
      carry = r.carryMillicents;
    }
    const oneShot = accrueInfraCharge(monthly, HOUR_MS, 0);
    expect(Math.abs(total + carry / 1000 - (oneShot.chargeCents + oneShot.carryMillicents / 1000))).toBeLessThan(1);
  });

  it('returns zero charge for zero elapsed or zero price', () => {
    expect(accrueInfraCharge(575, 0, 0).chargeCents).toBe(0);
    expect(accrueInfraCharge(0, HOUR_MS, 0).chargeCents).toBe(0);
  });
});

describe('minimumBalanceToStartCents', () => {
  it('requires 72 hours of coverage, not a full month', () => {
    const monthly = 575;
    const required = minimumBalanceToStartCents(monthly);
    expect(required).toBe(Math.ceil((575 * 72) / 730)); // ≈ 57¢
    expect(required).toBeLessThan(monthly / 5);
  });
});
