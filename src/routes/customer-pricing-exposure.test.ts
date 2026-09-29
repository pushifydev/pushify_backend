import { describe, it, expect } from 'vitest';
import { toCustomerDomain } from './registrar-domains';

/**
 * Provider cost, exchange rate, margin and registrar wholesale are internal numbers. These
 * checks pin the shapes that reach customers so a later field can't slip back in unnoticed.
 */
const FORBIDDEN = /providerCost|marginPercent|wholesale|eurToUsd|fxRate|priceEur/i;

describe('customer-facing pricing shapes', () => {
  it('purchased domains drop wholesale and renewal wholesale', () => {
    const row = {
      id: 'd1',
      domainName: 'example.com',
      purchasePriceCents: 1299,
      wholesalePriceCents: 899,
      renewalWholesaleCents: 999,
      autoRenew: true,
    };
    const out = toCustomerDomain(row);
    expect(out).toEqual({ id: 'd1', domainName: 'example.com', purchasePriceCents: 1299, autoRenew: true });
    expect(JSON.stringify(out)).not.toMatch(FORBIDDEN);
  });
});
