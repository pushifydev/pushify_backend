/**
 * Create the Stripe Prices for the 2026-09 repricing (Hobby $10→$15, Pro $25→$29).
 *
 * For each plan it looks up the product behind the CURRENT env-configured monthly
 * price, creates a new monthly price ($15/$29) and a new yearly price (20% off,
 * matching the UI's `round(price * 0.8) * 12` math) on that same product, then
 * prints the complete env block to paste: the new MONTHLY/YEARLY vars plus
 * STRIPE_PRICE_*_LEGACY lines carrying the retired IDs so existing subscribers'
 * webhooks keep resolving (see getPlanFromPriceId).
 *
 * Existing subscribers are untouched — they keep renewing on their old price.
 *
 * Idempotent: if an active price with the target amount/interval already exists on
 * the product, it is reused instead of creating a duplicate.
 *
 *   npm run stripe:create-prices              # dry run — shows what would be created
 *   npm run stripe:create-prices -- --apply   # actually creates the prices
 */
import type Stripe from 'stripe';
import { getStripe, STRIPE_PRICE_IDS } from '../src/lib/stripe';
import { getPlanInfo, type PlanType } from '../src/lib/plans';

const apply = process.argv.includes('--apply');

const YEARLY_DISCOUNT = 0.2; // keep in sync with the pricing UI's yearlyDiscount

const TARGETS: Array<{ plan: PlanType; envPrefix: string }> = [
  { plan: 'hobby', envPrefix: 'STRIPE_PRICE_HOBBY' },
  { plan: 'pro', envPrefix: 'STRIPE_PRICE_PRO' },
];

async function findOrCreatePrice(
  stripe: Stripe,
  opts: {
    plan: PlanType;
    productId: string;
    targetCents: number;
    interval: 'month' | 'year';
    skipId?: string;
  },
): Promise<string | null> {
  const { plan, productId, targetCents, interval, skipId } = opts;
  const label = `$${targetCents / 100}/${interval === 'month' ? 'mo' : 'yr'}`;

  const existing = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  const match = existing.data.find(
    (p) =>
      p.unit_amount === targetCents &&
      p.currency === 'usd' &&
      p.recurring?.interval === interval &&
      p.id !== skipId,
  );
  if (match) {
    console.log(`[${plan}] found existing ${label} price ${match.id} — reusing`);
    return match.id;
  }

  if (!apply) {
    console.log(`[${plan}] would create ${label} (usd) on product ${productId}`);
    return null;
  }

  const created = await stripe.prices.create({
    product: productId,
    unit_amount: targetCents,
    currency: 'usd',
    recurring: { interval },
    nickname: `${getPlanInfo(plan).name} ${label} (2026-09 repricing)`,
  });
  console.log(`[${plan}] created ${created.id} — ${label} on ${productId}`);
  return created.id;
}

async function main() {
  const stripe = getStripe();
  const envLines: string[] = [];

  for (const { plan, envPrefix } of TARGETS) {
    const planInfo = getPlanInfo(plan);
    const monthlyCents = planInfo.price * 100;
    // Match the UI display exactly: yearly shown as round(price * 0.8) per month.
    const yearlyCents = Math.round(planInfo.price * (1 - YEARLY_DISCOUNT)) * 12 * 100;

    const current = STRIPE_PRICE_IDS[plan];
    if (!current?.monthly) {
      console.error(`[${plan}] no current monthly price ID configured — skipping`);
      continue;
    }

    const currentPrice = await stripe.prices.retrieve(current.monthly);
    const productId =
      typeof currentPrice.product === 'string' ? currentPrice.product : currentPrice.product.id;
    console.log(
      `[${plan}] current monthly ${current.monthly} @ $${(currentPrice.unit_amount ?? 0) / 100} on product ${productId}`,
    );

    if (currentPrice.unit_amount === monthlyCents) {
      console.log(`[${plan}] already at $${planInfo.price}/mo — nothing to do`);
      envLines.push(`${envPrefix}_MONTHLY=${current.monthly}`);
      if (current.yearly) envLines.push(`${envPrefix}_YEARLY=${current.yearly}`);
      continue;
    }

    const newMonthly = await findOrCreatePrice(stripe, {
      plan,
      productId,
      targetCents: monthlyCents,
      interval: 'month',
      skipId: current.monthly,
    });
    const newYearly = await findOrCreatePrice(stripe, {
      plan,
      productId,
      targetCents: yearlyCents,
      interval: 'year',
      skipId: current.yearly,
    });

    envLines.push(`${envPrefix}_MONTHLY=${newMonthly ?? '<created on --apply>'}`);
    envLines.push(`${envPrefix}_YEARLY=${newYearly ?? '<created on --apply>'}`);

    // Retired IDs — everything the env pointed at before the swap. Keeps old
    // subscribers' webhook price→plan mapping alive. Merge with any existing
    // _LEGACY value if you have retired prices from an earlier repricing.
    const retired = [current.monthly, current.yearly]
      .filter((id, i, arr) => id && arr.indexOf(id) === i)
      .join(',');
    envLines.push(`${envPrefix}_LEGACY=${retired}`);
  }

  console.log(apply ? '\nReplace/add these on prod, then restart the backend:' : '\nAfter --apply you will get:');
  for (const line of envLines) console.log(`  ${line}`);
  if (!apply) console.log('\nDry run — re-run with `-- --apply` to create the prices.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
