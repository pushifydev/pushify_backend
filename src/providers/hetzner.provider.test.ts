import { describe, expect, it } from 'vitest';
import { resolveTier, type Catalogue } from './hetzner.provider';

type T = Catalogue['types'][number];

const type = (name: string, cores: number, memory: number, prices: Record<string, number>, extra: Partial<T> = {}): T => ({
  id: name.length * 1000 + cores * 10 + memory,
  name,
  description: name,
  cores,
  memory,
  disk: 40,
  deprecated: false,
  storage_type: 'local',
  cpu_type: 'shared',
  architecture: 'x86',
  prices: Object.entries(prices).map(([location, monthly]) => ({
    location,
    price_hourly: { gross: String(monthly / 730), net: String(monthly / 730) },
    price_monthly: { gross: String(monthly), net: String(monthly) },
  })),
  ...extra,
});

// Mirrors the live catalogue of 2026-09-26: cx23 is priced in three locations but only stocked
// in fsn1, and nbg1 has to fall back to the pricier cpx12.
const catalogue: Catalogue = {
  types: [
    type('cx23', 2, 4, { fsn1: 5.49, nbg1: 5.49, hel1: 5.49 }),
    type('cpx12', 1, 2, { fsn1: 11.49, nbg1: 11.49 }),
    type('cax11', 2, 4, { fsn1: 5.99, nbg1: 5.99 }, { architecture: 'arm' }),
    type('cx33', 4, 8, { fsn1: 8.49, nbg1: 8.49 }),
    type('cpx32', 4, 8, { fsn1: 35.49, nbg1: 35.49 }),
    type('ccx13', 2, 8, { fsn1: 42.99 }, { cpu_type: 'dedicated' }),
    type('old', 2, 4, { fsn1: 1 }, { deprecated: true }),
  ],
  inStock: new Map([
    ['fsn1', new Set(['cx23', 'cpx12', 'cax11', 'cpx32', 'ccx13', 'old'])],
    ['nbg1', new Set(['cpx12', 'cax11', 'cpx32'])],
  ]),
};

describe('resolveTier', () => {
  it('picks the cheapest in-stock x86 shared type in the location', () => {
    expect(resolveTier(catalogue, 'xs', 'fsn1')?.type.name).toBe('cx23');
    expect(resolveTier(catalogue, 'xs', 'fsn1')?.priceMonthly).toBe(5.49);
  });

  it('never offers a type that is priced but sold out in the location', () => {
    const nbg = resolveTier(catalogue, 'xs', 'nbg1');
    expect(nbg?.type.name).toBe('cpx12');
    expect(nbg?.priceMonthly).toBe(11.49);
    // cx33 is cheaper for md but in stock nowhere
    expect(resolveTier(catalogue, 'md', 'nbg1')?.type.name).toBe('cpx32');
  });

  it('skips deprecated, dedicated and other-architecture types unless asked', () => {
    expect(resolveTier(catalogue, 'sm', 'fsn1')?.type.name).toBe('cx23');
    expect(resolveTier(catalogue, 'xs', 'nbg1', 'arm')?.type.name).toBe('cax11');
  });

  it('without a location, returns the cheapest location that has it in stock', () => {
    const any = resolveTier(catalogue, 'xs');
    expect(any?.location).toBe('fsn1');
    expect(any?.type.name).toBe('cx23');
  });

  it('returns nothing when no type fits the tier in stock', () => {
    expect(resolveTier(catalogue, 'xl', 'fsn1')).toBeUndefined();
  });
});
