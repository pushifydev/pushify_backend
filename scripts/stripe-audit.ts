/**
 * READ-ONLY look at the Stripe account: which Hobby/Pro prices exist and are active, what the
 * last subscription checkouts actually charged, and why "incomplete" subscriptions are stuck
 * (the first invoice's payment error). Nothing is created or changed.
 *
 *   npm run stripe:audit        # uses STRIPE_SECRET_KEY from .env — run where the LIVE key lives
 */
import { getStripe } from '../src/lib/stripe';

async function main() {
  const stripe = getStripe();
  const money = (c: number | null | undefined, cur = 'usd') => c == null ? '—' : `$${(c / 100).toFixed(2)} ${cur}`;

  console.log('== active recurring prices (USD) ==');
  const prices = await stripe.prices.list({ active: true, type: 'recurring', limit: 100, expand: ['data.product'] });
  for (const p of prices.data.sort((a, b) => (a.unit_amount ?? 0) - (b.unit_amount ?? 0))) {
    const prod = typeof p.product === 'object' && p.product && 'name' in p.product ? p.product.name : String(p.product);
    console.log(`  ${p.id}  ${money(p.unit_amount, p.currency)}/${p.recurring?.interval}  product="${prod}"  created=${new Date(p.created * 1000).toISOString().slice(0, 10)}`);
  }
  const inactive = await stripe.prices.list({ active: false, type: 'recurring', limit: 100 });
  console.log(`  (+ ${inactive.data.length} archived recurring prices: ${inactive.data.map((p) => `${p.id}=${money(p.unit_amount)}`).join(', ')})`);

  console.log('\n== last 10 subscription checkout sessions ==');
  const sessions = await stripe.checkout.sessions.list({ limit: 30 });
  for (const s of sessions.data.filter((x) => x.mode === 'subscription').slice(0, 10)) {
    const items = await stripe.checkout.sessions.listLineItems(s.id, { limit: 3 });
    const li = items.data.map((i) => `${i.price?.id}=${money(i.amount_total, i.currency)}`).join(',');
    console.log(`  ${new Date(s.created * 1000).toISOString().slice(0, 16)}  status=${s.status}/${s.payment_status}  plan=${s.metadata?.planType}/${s.metadata?.billingCycle}  ${li}`);
  }

  console.log('\n== subscriptions: incomplete / incomplete_expired / past_due ==');
  for (const status of ['incomplete', 'incomplete_expired', 'past_due'] as const) {
    const subs = await stripe.subscriptions.list({ status, limit: 10, expand: ['data.latest_invoice.payment_intent'] });
    for (const sub of subs.data) {
      const inv = sub.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
      const pi = inv && inv.payment_intent && typeof inv.payment_intent === 'object' ? inv.payment_intent : null;
      const err = pi?.last_payment_error;
      const price = sub.items.data[0]?.price;
      console.log(`  [${status}] ${sub.id} created=${new Date(sub.created * 1000).toISOString().slice(0, 16)} price=${price?.id}=${money(price?.unit_amount)} org=${sub.metadata?.organizationId?.slice(0, 8)}`);
      console.log(`      invoice=${inv?.status ?? '—'} pi=${pi?.status ?? '—'} error=${err ? `${err.code}/${err.decline_code ?? '-'}: ${err.message?.slice(0, 120)}` : 'none'} next_action=${pi?.next_action?.type ?? '-'}`);
    }
    if (subs.data.length === 0) console.log(`  [${status}] none`);
  }

  console.log('\n== webhook endpoints ==');
  const hooks = await stripe.webhookEndpoints.list({ limit: 10 });
  for (const h of hooks.data) console.log(`  ${h.url}  status=${h.status}  events=${h.enabled_events.length}  api=${h.api_version ?? '-'}`);
}

main().catch((e) => { console.error('FAILED', e.message); process.exitCode = 1; });
