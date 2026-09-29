/**
 * Monthly included server credit — the pure rules. DB writes live in
 * services/included-credit.service.ts; everything that decides an amount is here and tested.
 *
 * Model (approved 2026-09-29):
 * - Each paid plan includes a fixed amount of managed-server credit per month
 *   (lib/plans.ts `includedInfraCreditCents`: Hobby $9, Pro $18, Business $45).
 * - It sits in its own balance, separate from the prepaid wallet, is spent before the wallet
 *   and only on managed-server charges, and does not roll over: each period resets it.
 * - Yearly subscriptions get it every month; the month boundary is the subscription's own
 *   renewal day.
 * - An upgrade mid-period adds the difference prorated to what is left of the period, the same
 *   way Stripe prorates the upgrade charge, and never lifts the period's total above the new
 *   plan's amount. A downgrade takes nothing back.
 */

export type BillingInterval = 'month' | 'year';

export interface CreditPeriod {
  /** Stable key for the period, the ISO date of its start (UTC). */
  key: string;
  start: Date;
  end: Date;
}

/** Adds calendar months, clamping to the last day of shorter months (Jan 31 + 1 → Feb 28/29). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * The credit period containing `now`. Monthly subscriptions use Stripe's own billing period;
 * yearly subscriptions are cut into month-long slices starting on the subscription's period
 * start (the last slice ends with the Stripe period).
 */
export function creditPeriod(
  interval: BillingInterval,
  periodStart: Date,
  periodEnd: Date,
  now: Date = new Date(),
): CreditPeriod {
  if (interval === 'month') {
    return { key: periodStart.toISOString().slice(0, 10), start: periodStart, end: periodEnd };
  }
  let k = 0;
  while (k < 12 && addMonths(periodStart, k + 1).getTime() <= now.getTime()) k++;
  const start = addMonths(periodStart, k);
  const next = addMonths(periodStart, k + 1);
  const end = next.getTime() < periodEnd.getTime() ? next : periodEnd;
  return { key: start.toISOString().slice(0, 10), start, end };
}

/** Share of the period still ahead of `now`, between 0 and 1. */
export function remainingFraction(period: CreditPeriod, now: Date = new Date()): number {
  const total = period.end.getTime() - period.start.getTime();
  if (total <= 0) return 0;
  const left = period.end.getTime() - now.getTime();
  return Math.min(1, Math.max(0, left / total));
}

/**
 * Credit to add when a plan goes up mid-period: the difference between the plans' monthly
 * amounts, prorated to the time left (matching Stripe's prorated charge), capped so the period's
 * total never exceeds the new plan's amount. Zero for downgrades and lateral moves.
 */
export function upgradeGrantCents(opts: {
  fromAmountCents: number;
  toAmountCents: number;
  alreadyGrantedThisPeriodCents: number;
  fractionRemaining: number;
}): number {
  const diff = opts.toAmountCents - opts.fromAmountCents;
  if (diff <= 0) return 0;
  const prorated = Math.floor(diff * opts.fractionRemaining);
  const headroom = opts.toAmountCents - opts.alreadyGrantedThisPeriodCents;
  return Math.max(0, Math.min(prorated, headroom));
}

/**
 * How a managed-server charge is paid: included credit first, then the wallet. `null` when the
 * two together cannot cover it (the caller stops the server, as before).
 */
export function splitCharge(
  chargeCents: number,
  includedCents: number,
  walletCents: number,
): { fromIncludedCents: number; fromWalletCents: number } | null {
  const fromIncludedCents = Math.min(Math.max(0, includedCents), chargeCents);
  const fromWalletCents = chargeCents - fromIncludedCents;
  if (fromWalletCents > walletCents) return null;
  return { fromIncludedCents, fromWalletCents };
}
