/**
 * End-to-end check of period-end plan changes and included credit against Stripe TEST mode,
 * using test clocks to really move past the period end.
 *
 *   TESTCLOCK_DATABASE_URL="postgresql:///pushify_credit_test?host=/tmp" \
 *     npx tsx scripts/stripe-testclock-plan-changes.mts
 *
 * Safety: refuses to run unless STRIPE_SECRET_KEY is a test key and TESTCLOCK_DATABASE_URL is a
 * local database. Creates its own product/prices, and deletes the test clocks (with their
 * customers and subscriptions) and archives the prices at the end. Webhooks are delivered by
 * reading the events Stripe generated and handing them to the same processWebhookEvent the
 * webhook route uses (no signature step).
 */
import 'dotenv/config';

const dbUrl = process.env.TESTCLOCK_DATABASE_URL ?? '';
const key = process.env.STRIPE_SECRET_KEY ?? '';
if (!key.startsWith('sk_test_')) throw new Error('STRIPE_SECRET_KEY must be a test-mode key (sk_test_…)');
const dbHost = (() => {
  try {
    return new URL(dbUrl).hostname;
  } catch {
    return 'invalid';
  }
})();
if (!dbUrl || !['', 'localhost', '127.0.0.1'].includes(dbHost)) {
  throw new Error('TESTCLOCK_DATABASE_URL must point at a local database');
}
process.env.DATABASE_URL = dbUrl;
process.env.ADMIN_NOTIFY_EMAILS = '';
process.env.ADMIN_EMAILS = '';

const { default: Stripe } = await import('stripe');
const stripe = new Stripe(key, { apiVersion: '2026-02-25.clover' as Stripe.LatestApiVersion });

// ── Test catalogue ──────────────────────────────────────────────────────────────────────────
const stamp = Date.now();
const product = await stripe.products.create({ name: `Pushify test-clock ${stamp}` });
const mk = (cents: number) =>
  stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: cents, recurring: { interval: 'month' } });
const [pHobby, pPro, pBusiness] = await Promise.all([mk(1500), mk(2900), mk(9900)]);
process.env.STRIPE_PRICE_HOBBY_MONTHLY = pHobby.id;
process.env.STRIPE_PRICE_PRO_MONTHLY = pPro.id;
process.env.STRIPE_PRICE_BUSINESS_MONTHLY = pBusiness.id;
process.env.STRIPE_PRICE_HOBBY_YEARLY = '';
process.env.STRIPE_PRICE_PRO_YEARLY = '';
process.env.STRIPE_PRICE_BUSINESS_YEARLY = '';

// App modules read env at import time: import them only now.
const { db } = await import('../src/db');
const { organizations, includedCreditGrants } = await import('../src/db/schema');
const { eq, sql } = await import('drizzle-orm');
const { stripeService } = await import('../src/services/stripe.service');
const { getStripe } = await import('../src/lib/stripe');

const results: { scenario: string; check: string; ok: boolean; detail?: string }[] = [];
const expect = (scenario: string, check: string, ok: boolean, detail?: unknown) => {
  results.push({ scenario, check, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });
  console.log(`${ok ? '  ✓' : '  ✗'} ${check}${ok || detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clocks: string[] = [];
const orgIds: string[] = [];

async function advance(clockId: string, to: number) {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: to });
  for (let i = 0; i < 120; i++) {
    const c = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (c.status === 'ready') return;
    if (c.status === 'internal_failure') throw new Error('test clock failed');
    await sleep(2000);
  }
  throw new Error('test clock did not become ready');
}

/** Hand every not-yet-delivered event about this customer to the webhook processor, oldest first. */
const delivered = new Set<string>();
async function deliver(customerId: string, subId: string) {
  await sleep(2500);
  const events: Stripe.Event[] = [];
  for await (const e of stripe.events.list({ limit: 100, created: { gte: Math.floor(stamp / 1000) - 60 } })) {
    if (delivered.has(e.id)) continue;
    const o = e.data.object as { id?: string; customer?: string; subscription?: string | { id: string } };
    const sub = typeof o.subscription === 'string' ? o.subscription : o.subscription?.id;
    if (o.customer === customerId || o.id === subId || sub === subId) events.push(e);
    if (events.length > 200) break;
  }
  events.sort((a, b) => a.created - b.created);
  for (const e of events) {
    delivered.add(e.id);
    await stripeService.processWebhookEvent(e, getStripe());
  }
  return events.map((e) => e.type);
}

async function setup(name: string, price: Stripe.Price, plan: 'hobby' | 'pro' | 'business') {
  const now = Math.floor(Date.now() / 1000);
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: now, name: `${name} ${stamp}` });
  clocks.push(clock.id);
  const customer = await stripe.customers.create({
    test_clock: clock.id,
    email: `testclock+${stamp}@example.com`,
    payment_method: 'pm_card_visa',
    invoice_settings: { default_payment_method: 'pm_card_visa' },
  });
  const [org] = await db
    .insert(organizations)
    .values({ name: `testclock-${name}`, slug: `testclock-${name}-${stamp}`, plan, stripeCustomerId: customer.id, billingStatus: 'active' })
    .returning();
  orgIds.push(org.id);
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: price.id }],
    metadata: { organizationId: org.id, planType: plan },
  });
  await db.update(organizations).set({ stripeSubscriptionId: sub.id }).where(eq(organizations.id, org.id));
  await deliver(customer.id, sub.id);
  return { clock, customer, sub, org, periodEnd: sub.items.data[0].current_period_end };
}

const orgRow = async (id: string) => (await db.select().from(organizations).where(eq(organizations.id, id)))[0];
const grants = (id: string) => db.select().from(includedCreditGrants).where(eq(includedCreditGrants.organizationId, id));

try {
  // ── A. Downgrade takes effect at period end, credit follows ───────────────────────────────
  console.log('\nA. Business → Hobby at period end');
  {
    const s = await setup('A', pBusiness, 'business');
    let o = await orgRow(s.org.id);
    expect('A', 'Business credit $45 on the first period', o.includedCreditCents === 4500, o.includedCreditCents);
    const r = await stripeService.changePlan(s.org.id, 'hobby', 'monthly');
    expect('A', 'change is scheduled, not applied', r.status === 'scheduled', r);
    const live = await stripe.subscriptions.retrieve(s.sub.id);
    expect('A', 'Stripe still bills Business this period', live.items.data[0].price.id === pBusiness.id);
    expect('A', 'subscription has a schedule', !!live.schedule);
    await deliver(s.customer.id, s.sub.id);
    o = await orgRow(s.org.id);
    expect('A', 'plan stays Business until period end', o.plan === 'business', o.plan);
    expect('A', 'pending change mirrored (Hobby at period end)', o.pendingPlan === 'hobby' && o.pendingChangeAt?.getTime() === s.periodEnd * 1000, [o.pendingPlan, o.pendingChangeAt]);
    await db.update(organizations).set({ includedCreditCents: 1200 }).where(eq(organizations.id, s.org.id));

    await advance(s.clock.id, s.periodEnd + 3600);
    const types = await deliver(s.customer.id, s.sub.id);
    o = await orgRow(s.org.id);
    const after = await stripe.subscriptions.retrieve(s.sub.id);
    expect('A', 'Stripe now bills Hobby', after.items.data[0].price.id === pHobby.id);
    expect('A', 'plan is Hobby after period end', o.plan === 'hobby', o.plan);
    expect('A', 'pending change cleared', o.pendingPlan === null && o.stripeScheduleId === null, [o.pendingPlan, o.stripeScheduleId]);
    expect('A', 'new period credit is Hobby $9', o.includedCreditCents === 900, o.includedCreditCents);
    const g = await grants(s.org.id);
    expect('A', 'Business remainder expired, not rolled over', g.some((x) => x.kind === 'expire' && x.amountCents === -1200), g.map((x) => [x.kind, x.amountCents]));
    const inv = await stripe.invoices.list({ subscription: s.sub.id, limit: 5 });
    const renewal = inv.data.find((i) => i.billing_reason === 'subscription_cycle');
    expect('A', 'renewal invoice is $15 with no proration lines', renewal?.amount_due === 1500 && (renewal?.lines.data.length ?? 0) === 1, [renewal?.amount_due, renewal?.lines.data.length]);
    expect('A', 'events delivered include schedule + renewal', types.includes('invoice.paid'), types);
  }

  // ── B. Cancelling a pending downgrade keeps the plan ─────────────────────────────────────
  console.log('\nB. Pro → Hobby scheduled, then cancelled');
  {
    const s = await setup('B', pPro, 'pro');
    await stripeService.changePlan(s.org.id, 'hobby', 'monthly');
    await deliver(s.customer.id, s.sub.id);
    const r = await stripeService.cancelScheduledChange(s.org.id);
    expect('B', 'schedule released', r.released === true, r);
    await deliver(s.customer.id, s.sub.id);
    let o = await orgRow(s.org.id);
    expect('B', 'pending change cleared', o.pendingPlan === null, o.pendingPlan);
    await advance(s.clock.id, s.periodEnd + 3600);
    await deliver(s.customer.id, s.sub.id);
    o = await orgRow(s.org.id);
    const after = await stripe.subscriptions.retrieve(s.sub.id);
    expect('B', 'still Pro in Stripe and here', after.items.data[0].price.id === pPro.id && o.plan === 'pro', [o.plan]);
    expect('B', 'new period credit is Pro $18', o.includedCreditCents === 1800, o.includedCreditCents);
  }

  // ── C. Cancelling the subscription clears the pending change ─────────────────────────────
  console.log('\nC. Business → Pro scheduled, then subscription cancelled');
  {
    const s = await setup('C', pBusiness, 'business');
    await stripeService.changePlan(s.org.id, 'pro', 'monthly');
    await deliver(s.customer.id, s.sub.id);
    await stripeService.cancelSubscription(s.org.id);
    await deliver(s.customer.id, s.sub.id);
    let o = await orgRow(s.org.id);
    const live = await stripe.subscriptions.retrieve(s.sub.id);
    expect('C', 'schedule gone, cancel at period end set', !live.schedule && live.cancel_at_period_end, [live.schedule, live.cancel_at_period_end]);
    expect('C', 'pending change cleared', o.pendingPlan === null, o.pendingPlan);
    await advance(s.clock.id, s.periodEnd + 3600);
    await deliver(s.customer.id, s.sub.id);
    o = await orgRow(s.org.id);
    expect('C', 'plan is Free after the end', o.plan === 'free', o.plan);
    expect('C', 'included credit expired', o.includedCreditCents === 0, o.includedCreditCents);
  }

  // ── D. A schedule edited or released in Stripe stays mirrored ────────────────────────────
  console.log('\nD. Schedule edited, then released, directly in Stripe');
  {
    const s = await setup('D', pBusiness, 'business');
    await stripeService.changePlan(s.org.id, 'hobby', 'monthly');
    await deliver(s.customer.id, s.sub.id);
    const live = await stripe.subscriptions.retrieve(s.sub.id);
    const schedId = typeof live.schedule === 'string' ? live.schedule : live.schedule!.id;
    const sched = await stripe.subscriptionSchedules.retrieve(schedId);
    await stripe.subscriptionSchedules.update(schedId, {
      phases: [
        { items: [{ price: pBusiness.id, quantity: 1 }], start_date: sched.phases[0].start_date, end_date: sched.phases[0].end_date },
        { items: [{ price: pPro.id, quantity: 1 }], duration: { interval: 'month', interval_count: 1 } },
      ],
    });
    await deliver(s.customer.id, s.sub.id);
    let o = await orgRow(s.org.id);
    expect('D', 'edit in Stripe → pending becomes Pro', o.pendingPlan === 'pro', o.pendingPlan);
    await stripe.subscriptionSchedules.release(schedId);
    await deliver(s.customer.id, s.sub.id);
    o = await orgRow(s.org.id);
    expect('D', 'release in Stripe → pending cleared', o.pendingPlan === null && o.stripeScheduleId === null, [o.pendingPlan, o.stripeScheduleId]);
  }

  // ── E. Upgrading replaces a pending downgrade and applies now ────────────────────────────
  console.log('\nE. Pro → Hobby scheduled, then upgrade to Business');
  {
    const s = await setup('E', pPro, 'pro');
    await stripeService.changePlan(s.org.id, 'hobby', 'monthly');
    await deliver(s.customer.id, s.sub.id);
    const r = await stripeService.changePlan(s.org.id, 'business', 'monthly');
    expect('E', 'upgrade applied now', r.status === 'changed', r);
    await deliver(s.customer.id, s.sub.id);
    const o = await orgRow(s.org.id);
    const live = await stripe.subscriptions.retrieve(s.sub.id);
    expect('E', 'Stripe bills Business, no schedule left', live.items.data[0].price.id === pBusiness.id && !live.schedule);
    expect('E', 'plan Business, pending cleared', o.plan === 'business' && o.pendingPlan === null, [o.plan, o.pendingPlan]);
    expect('E', 'upgrade credit added (≤ $27 difference)', o.includedCreditCents > 1800 && o.includedCreditCents <= 4500, o.includedCreditCents);
  }
} finally {
  console.log('\nCleanup');
  for (const id of clocks) await stripe.testHelpers.testClocks.del(id).catch(() => undefined);
  for (const p of [pHobby, pPro, pBusiness]) await stripe.prices.update(p.id, { active: false }).catch(() => undefined);
  await stripe.products.update(product.id, { active: false }).catch(() => undefined);
  if (orgIds.length) await db.execute(sql`delete from organizations where name like 'testclock-%'`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
