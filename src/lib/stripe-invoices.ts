import type Stripe from 'stripe';

/** The subscription an invoice bills, if any (API 2025+: under `parent.subscription_details`). */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription;
  if (!sub) return null;
  return typeof sub === 'string' ? sub : sub.id;
}

/**
 * Whether paying this invoice buys the organisation something: a one-off invoice, or one of its
 * current subscription. An invoice left open by a subscription that has since ended (Stripe gave
 * up retrying and cancelled it) or been replaced would charge the customer for nothing — it is
 * never offered for payment, retried, or counted as debt that blocks the organisation.
 */
export function isPayableInvoice(invoice: Stripe.Invoice, currentSubscriptionId: string | null): boolean {
  const sub = invoiceSubscriptionId(invoice);
  return !sub || sub === currentSubscriptionId;
}
