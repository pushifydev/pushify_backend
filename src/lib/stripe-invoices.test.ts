import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import { isPayableInvoice } from './stripe-invoices';

const inv = (subscription: string | null) =>
  ({ parent: subscription ? { subscription_details: { subscription } } : null }) as unknown as Stripe.Invoice;

describe('isPayableInvoice', () => {
  it('a one-off invoice is payable', () => expect(isPayableInvoice(inv(null), null)).toBe(true));
  it("the current subscription's invoice is payable", () => expect(isPayableInvoice(inv('sub_1'), 'sub_1')).toBe(true));
  it('an ended subscription’s invoice is not, even with no current subscription', () => {
    expect(isPayableInvoice(inv('sub_old'), null)).toBe(false);
    expect(isPayableInvoice(inv('sub_old'), 'sub_new')).toBe(false);
  });
});
