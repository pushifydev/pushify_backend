import { env } from '../config/env';

/**
 * Retail pricing for sold domains: wholesale (what the registrar charges us)
 * plus a configurable margin, rounded UP to a x.49 / x.99 ending so prices look
 * intentional. The margin is DOMAIN_MARGIN_PERCENT (default 20); purchases above
 * DOMAIN_MAX_PRICE_CENTS (default $300) are refused as a fat-finger/premium guard.
 */

export const DEFAULT_DOMAIN_MARGIN_PERCENT = 20;
export const DEFAULT_DOMAIN_MAX_PRICE_CENTS = 30_000;

export function domainMarginPercent(): number {
  const raw = env.DOMAIN_MARGIN_PERCENT;
  if (typeof raw === 'number' && isFinite(raw) && raw >= 0 && raw <= 500) return raw;
  return DEFAULT_DOMAIN_MARGIN_PERCENT;
}

export function domainMaxPriceCents(): number {
  const raw = env.DOMAIN_MAX_PRICE_CENTS;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  return DEFAULT_DOMAIN_MAX_PRICE_CENTS;
}

/** Smallest x.49/x.99-ending amount that is >= cents. */
export function roundUpToRetailEnding(cents: number): number {
  return Math.ceil((cents + 1) / 50) * 50 - 1;
}

export function retailFromWholesaleCents(
  wholesaleCents: number,
  marginPercent: number = domainMarginPercent()
): number {
  if (!Number.isInteger(wholesaleCents) || wholesaleCents <= 0) {
    throw new Error(`Invalid wholesale price: ${wholesaleCents}`);
  }
  const withMargin = Math.ceil(wholesaleCents * (1 + marginPercent / 100));
  return roundUpToRetailEnding(withMargin);
}
