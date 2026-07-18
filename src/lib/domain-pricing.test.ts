import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOMAIN_MARGIN_PERCENT,
  retailFromWholesaleCents,
  roundUpToRetailEnding,
} from './domain-pricing';

describe('roundUpToRetailEnding', () => {
  it('rounds up to the nearest x.49/x.99 ending', () => {
    expect(roundUpToRetailEnding(1300)).toBe(1349);
    expect(roundUpToRetailEnding(1349)).toBe(1349);
    expect(roundUpToRetailEnding(1350)).toBe(1399);
    expect(roundUpToRetailEnding(1399)).toBe(1399);
    expect(roundUpToRetailEnding(1400)).toBe(1449);
  });
});

describe('retailFromWholesaleCents', () => {
  it('applies the margin and never sells below wholesale', () => {
    // $10.99 wholesale + 20% = $13.188 → $13.49
    expect(retailFromWholesaleCents(1099, 20)).toBe(1349);
    // 0% margin: already a retail ending, stays at cost — never below it
    expect(retailFromWholesaleCents(1099, 0)).toBe(1099);
    expect(retailFromWholesaleCents(1100, 0)).toBe(1149);
    for (const wholesale of [101, 999, 1234, 7000]) {
      expect(retailFromWholesaleCents(wholesale, DEFAULT_DOMAIN_MARGIN_PERCENT)).toBeGreaterThan(
        wholesale
      );
    }
  });

  it('rejects nonsense wholesale prices', () => {
    expect(() => retailFromWholesaleCents(0, 20)).toThrow();
    expect(() => retailFromWholesaleCents(-500, 20)).toThrow();
    expect(() => retailFromWholesaleCents(10.5 as unknown as number, 20)).toThrow();
  });
});
