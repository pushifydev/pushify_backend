import { afterEach, describe, expect, it, vi } from 'vitest';
import { HetznerProvider, resolveTier, type Catalogue } from './hetzner.provider';

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

describe('listSnapshotIdsCreatedFrom', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('matches created_from across every page, including snapshots of deleted servers', async () => {
    const pages: Record<string, unknown> = {
      '1': {
        images: [
          { id: 11, created_from: { id: 9001, name: 'gone' } },
          { id: 12, created_from: { id: 1234, name: 'other' } },
          { id: 13, created_from: null },
        ],
        meta: { pagination: { next_page: 2 } },
      },
      '2': { images: [{ id: 21, created_from: { id: 9001, name: 'gone' } }], meta: { pagination: { next_page: null } } },
    };
    const fetchMock = vi.fn(async (url: string) => {
      const page = new URL(url).searchParams.get('page')!;
      return new Response(JSON.stringify(pages[page]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const ids = await new HetznerProvider('token').listSnapshotIdsCreatedFrom('9001');
    expect(ids).toEqual(['11', '21']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('type=snapshot');
    expect(fetchMock.mock.calls[0][0]).not.toContain('bound_to');
  });
});

describe('listSnapshots', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists one server\'s snapshots by created_from (bound_to returns nothing for snapshots)', async () => {
    const images = [
      { id: 1, description: 'a', image_size: 1, disk_size: 20, created: '2026-09-01T00:00:00Z', status: 'available', created_from: { id: 5, name: 's' } },
      { id: 2, description: 'b', image_size: 1, disk_size: 20, created: '2026-09-02T00:00:00Z', status: 'available', created_from: { id: 6, name: 't' } },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ images, meta: { pagination: { next_page: null } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new HetznerProvider('token');
    expect((await provider.listSnapshots('5')).map((s) => s.id)).toEqual(['1']);
    expect((await provider.listSnapshots()).map((s) => s.id)).toEqual(['1', '2']);
    for (const call of fetchMock.mock.calls as unknown as [string][]) expect(call[0]).not.toContain('bound_to');
  });
});
