/**
 * READ-ONLY: why is this organisation blocked by billing? Prints the organisation's billing row
 * next to what Stripe says — every subscription of its customer and every open invoice — and a
 * one-line verdict. Nothing is created or changed.
 *
 *   npm run billing:diagnose -- --server <serverId>
 *   npm run billing:diagnose -- --org <organizationId>
 *
 * Run on the API host (it needs DATABASE_URL and the LIVE STRIPE_SECRET_KEY from .env).
 */
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { db, closeDatabasePool } from '../src/db';
import { organizations } from '../src/db/schema/organizations';
import { servers } from '../src/db/schema';
import { getStripe } from '../src/lib/stripe';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const money = (c: number | null | undefined, cur = 'usd') => (c == null ? '—' : `$${(c / 100).toFixed(2)} ${cur}`);
const when = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toISOString().slice(0, 16) : '—');

function invoiceSub(inv: Stripe.Invoice): string | null {
  const s = inv.parent?.subscription_details?.subscription;
  return s ? (typeof s === 'string' ? s : s.id) : null;
}

async function main() {
  let orgId = arg('--org');
  const serverId = arg('--server');
  if (!orgId && serverId) {
    const [server] = await db
      .select({ organizationId: servers.organizationId, status: servers.status, statusMessage: servers.statusMessage })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    if (!server) throw new Error(`server ${serverId} not found`);
    console.log(`server  ${serverId}  status=${server.status}  statusMessage=${server.statusMessage ?? '-'}`);
    orgId = server.organizationId;
  }
  if (!orgId) throw new Error('--server <id> or --org <id> is required');

  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      plan: organizations.plan,
      billingStatus: organizations.billingStatus,
      stripeCustomerId: organizations.stripeCustomerId,
      stripeSubscriptionId: organizations.stripeSubscriptionId,
      periodEnd: organizations.stripeCurrentPeriodEnd,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error(`organization ${orgId} not found`);

  console.log(
    `org     ${org.id}  "${org.name}"  plan=${org.plan}  billingStatus=${org.billingStatus}\n` +
      `        customer=${org.stripeCustomerId ?? 'NONE'}  currentSubscription=${org.stripeSubscriptionId ?? 'NONE'}  periodEnd=${org.periodEnd?.toISOString().slice(0, 16) ?? '—'}`,
  );
  if (!org.stripeCustomerId) {
    console.log('\nverdict: no Stripe customer — nothing in Stripe can explain the flag.');
    return;
  }

  const stripe = getStripe();
  console.log('\n== subscriptions of this customer ==');
  const subs = await stripe.subscriptions.list({ customer: org.stripeCustomerId, status: 'all', limit: 20 });
  for (const sub of subs.data) {
    const price = sub.items.data[0]?.price;
    const mark = sub.id === org.stripeSubscriptionId ? '  <- current' : '';
    console.log(
      `  ${sub.id}  ${sub.status}  price=${price?.id}=${money(price?.unit_amount)}/${price?.recurring?.interval}  created=${when(sub.created)}  cancel_at_period_end=${sub.cancel_at_period_end}${mark}`,
    );
  }

  console.log('\n== open invoices ==');
  const open = await stripe.invoices.list({ customer: org.stripeCustomerId, status: 'open', limit: 20 });
  if (open.data.length === 0) console.log('  none');
  for (const inv of open.data) {
    const sub = invoiceSub(inv);
    const mark = sub && sub === org.stripeSubscriptionId ? 'current' : sub ? 'OLDER subscription' : 'no subscription';
    console.log(
      `  ${inv.id}  ${money(inv.amount_due, inv.currency)}  sub=${sub ?? '-'} (${mark})  attempts=${inv.attempt_count}  next_attempt=${when(inv.next_payment_attempt)}\n      pay: ${inv.hosted_invoice_url ?? '—'}`,
    );
  }

  const current = subs.data.find((s) => s.id === org.stripeSubscriptionId);
  const live = subs.data.filter((s) => ['active', 'trialing', 'past_due', 'unpaid'].includes(s.status));
  console.log('\nverdict:');
  if (org.billingStatus !== 'past_due') console.log(`  billingStatus is ${org.billingStatus}, not past_due.`);
  else if (!org.stripeSubscriptionId) console.log('  past_due with no current subscription linked — the self-heal cannot run; link or clear it.');
  else if (!current) console.log('  the linked subscription is not on this customer — the link is wrong.');
  else if (current.status === 'active' || current.status === 'trialing')
    console.log('  Stripe says the current subscription is fine — beta.67 clears this on the next action. If it did not, the API is not running beta.67.');
  else
    console.log(`  the current subscription really is ${current.status}: its invoice must be paid (pay link above, or "Pay now" in Billing).`);
  if (live.length > 1) console.log(`  ${live.length} live subscriptions on one customer — cancel the ones that are not current.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabasePool());
