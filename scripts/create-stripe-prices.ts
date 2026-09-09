/**
 * Create the Stripe Prices for the 2026-09 repricing (Hobby $10→$15, Pro $25→$29).
 *
 * Looks up the product behind each plan's CURRENT (legacy) price, creates a new
 * monthly price on that same product, and prints the env lines to set on prod.
 * Existing subscribers stay on their old price; only new checkouts use the new one
 * (and `getPlanFromPriceId` keeps resolving legacy IDs for renewal webhooks).
 *
 * Idempotent: if an active monthly price with the target amount already exists on
 * the product, it is reused instead of creating a duplicate.
 *
 *   npm run stripe:create-prices              # dry run — shows what would be created
 *   npm run stripe:create-prices -- --apply   # actually creates the prices
 */
import { getStripe, STRIPE_PRICE_IDS } from '../src/lib/stripe';
import { getPlanInfo, type PlanType } from '../src/lib/plans';

const apply = process.argv.includes('--apply');

const TARGETS: Array<{ plan: PlanType; envVar: string }> = [
  { plan: 'hobby', envVar: 'STRIPE_PRICE_HOBBY_MONTHLY' },
  { plan: 'pro', envVar: 'STRIPE_PRICE_PRO_MONTHLY' },
];

async function main() {
  const stripe = getStripe();
  const envLines: string[] = [];

  for (const { plan, envVar } of TARGETS) {
    const planInfo = getPlanInfo(plan);
    const targetCents = planInfo.price * 100;
    const currentPriceId = STRIPE_PRICE_IDS[plan]?.monthly;
    if (!currentPriceId) {
      console.error(`[${plan}] no current price ID configured — skipping`);
      continue;
    }

    const currentPrice = await stripe.prices.retrieve(currentPriceId);
    const productId =
      typeof currentPrice.product === 'string' ? currentPrice.product : currentPrice.product.id;

    if (currentPrice.unit_amount === targetCents) {
      console.log(`[${plan}] current price ${currentPriceId} is already $${planInfo.price}/mo — nothing to do`);
      envLines.push(`${envVar}=${currentPriceId}`);
      continue;
    }

    // Reuse an existing matching price if one was already created.
    const existing = await stripe.prices.list({ product: productId, active: true, limit: 100 });
    const match = existing.data.find(
      (p) =>
        p.unit_amount === targetCents &&
        p.currency === 'usd' &&
        p.recurring?.interval === 'month' &&
        p.id !== currentPriceId,
    );
    if (match) {
      console.log(`[${plan}] found existing $${planInfo.price}/mo price ${match.id} — reusing`);
      envLines.push(`${envVar}=${match.id}`);
      continue;
    }

    if (!apply) {
      console.log(
        `[${plan}] would create $${planInfo.price}/mo (usd, monthly) on product ${productId} ` +
          `(current: ${currentPriceId} @ $${(currentPrice.unit_amount ?? 0) / 100})`,
      );
      envLines.push(`${envVar}=<created on --apply>`);
      continue;
    }

    const created = await stripe.prices.create({
      product: productId,
      unit_amount: targetCents,
      currency: 'usd',
      recurring: { interval: 'month' },
      nickname: `${planInfo.name} $${planInfo.price}/mo (2026-09 repricing)`,
    });
    console.log(`[${plan}] created ${created.id} — $${planInfo.price}/mo on ${productId}`);
    envLines.push(`${envVar}=${created.id}`);
  }

  console.log(apply ? '\nSet these on prod, then deploy:' : '\nAfter --apply you will get:');
  for (const line of envLines) console.log(`  ${line}`);
  if (!apply) console.log('\nDry run — re-run with `-- --apply` to create the prices.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
