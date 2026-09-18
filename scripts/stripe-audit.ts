/**
 * READ-ONLY look at the Stripe account: which recurring prices exist and are active, what the
 * last subscription checkouts actually charged, and why stuck subscriptions are stuck (the
 * latest invoice's payment attempts and their decline codes). Nothing is created or changed.
 *
 *   npm run stripe:audit        # uses STRIPE_SECRET_KEY from .env — run where the LIVE key lives
 */
import type Stripe from 'stripe';
import { getStripe } from '../src/lib/stripe';

const money = (c: number | null | undefined, cur = 'usd') =>
  c == null ? '—' : `$${(c / 100).toFixed(2)} ${cur}`;
const when = (unix: number | null | undefined) =>
  unix ? new Date(unix * 1000).toISOString().slice(0, 16) : '—';

/** The invoice's payment attempts. Stripe API ≥ 2025-03 exposes them as `invoice.payments`,
 *  not `invoice.payment_intent`. */
async function describeInvoicePayments(stripe: Stripe, invoiceId: string): Promise<string[]> {
  const invoice = await stripe.invoices.retrieve(invoiceId, {
    expand: ['payments.data.payment.payment_intent'],
  });
  const lines = [
    `invoice=${invoice.status} ${money(invoice.amount_due, invoice.currency)} attempts=${invoice.attempt_count} next_attempt=${when(invoice.next_payment_attempt)} collection=${invoice.collection_method}`,
  ];
  const payments = invoice.payments?.data ?? [];
  if (payments.length === 0) lines.push('no payment attempt on this invoice yet');
  for (const p of payments) {
    const pi = p.payment.payment_intent;
    if (!pi || typeof pi === 'string') {
      lines.push(`payment ${p.status} (${p.payment.type})`);
      continue;
    }
    const err = pi.last_payment_error;
    lines.push(
      `payment ${p.status}: pi=${pi.status} ${err ? `error=${err.code ?? '?'}/${err.decline_code ?? '-'} "${(err.message ?? '').slice(0, 140)}"` : 'no error'} next_action=${pi.next_action?.type ?? '-'}`,
    );
  }
  return lines;
}

async function main() {
  const stripe = getStripe();

  console.log('== active recurring prices (USD) ==');
  const prices = await stripe.prices.list({ active: true, type: 'recurring', limit: 100, expand: ['data.product'] });
  for (const p of prices.data.sort((a, b) => (a.unit_amount ?? 0) - (b.unit_amount ?? 0))) {
    const prod = typeof p.product === 'object' && p.product && 'name' in p.product ? p.product.name : String(p.product);
    console.log(`  ${p.id}  ${money(p.unit_amount, p.currency)}/${p.recurring?.interval}  product="${prod}"  created=${when(p.created).slice(0, 10)}`);
  }
  const inactive = await stripe.prices.list({ active: false, type: 'recurring', limit: 100 });
  console.log(`  (+ ${inactive.data.length} archived recurring prices: ${inactive.data.map((p) => `${p.id}=${money(p.unit_amount)}`).join(', ')})`);

  console.log('\n== last 10 subscription checkout sessions ==');
  const sessions = await stripe.checkout.sessions.list({ limit: 30 });
  for (const s of sessions.data.filter((x) => x.mode === 'subscription').slice(0, 10)) {
    const items = await stripe.checkout.sessions.listLineItems(s.id, { limit: 3 });
    const li = items.data.map((i) => `${i.price?.id}=${money(i.amount_total, i.currency)}`).join(',');
    console.log(`  ${when(s.created)}  status=${s.status}/${s.payment_status}  plan=${s.metadata?.planType}/${s.metadata?.billingCycle}  ${li}`);
  }

  console.log('\n== subscriptions: incomplete / incomplete_expired / past_due / unpaid ==');
  for (const status of ['incomplete', 'incomplete_expired', 'past_due', 'unpaid'] as const) {
    const subs = await stripe.subscriptions.list({ status, limit: 10 });
    if (subs.data.length === 0) {
      console.log(`  [${status}] none`);
      continue;
    }
    for (const sub of subs.data) {
      const price = sub.items.data[0]?.price;
      const pm = sub.default_payment_method ?? sub.default_source;
      console.log(
        `  [${status}] ${sub.id} created=${when(sub.created)} price=${price?.id}=${money(price?.unit_amount)} org=${sub.metadata?.organizationId?.slice(0, 8) ?? '-'} default_pm=${pm ? 'yes' : 'NONE'}`,
      );
      const invoiceId = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id;
      if (invoiceId) {
        for (const line of await describeInvoicePayments(stripe, invoiceId)) console.log(`      ${line}`);
      }
    }
  }

  console.log('\n== webhook endpoints ==');
  const hooks = await stripe.webhookEndpoints.list({ limit: 10 });
  for (const h of hooks.data) console.log(`  ${h.url}  status=${h.status}  events=${h.enabled_events.join(',')}  api=${h.api_version ?? '-'}`);
}

main().catch((e) => {
  console.error('FAILED', e.message);
  process.exitCode = 1;
});
