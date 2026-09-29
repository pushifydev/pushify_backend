import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env')>();
  return { env: { ...actual.env, HETZNER_API_TOKEN: 'test-token' } };
});
vi.mock('../lib/fx-rate', () => ({ getEurToUsdRate: () => 1.1 }));
vi.mock('../providers', () => ({
  createProvider: () => ({
    listSizes: async () => [
      { size: 'xs', specs: { vcpus: 2, memoryMb: 4096, diskGb: 40, priceMonthly: 4.99, serverType: 'cx23' } },
    ],
  }),
}));

import { infraBillingService } from './infra-billing.service';

describe('dashboard server sizes', () => {
  it('carry customer prices only — no provider cost, exchange rate or margin', async () => {
    const sizes = await infraBillingService.getSizedOptionsForOrganization('org', 'hobby', 'hetzner', 'fsn1', 'en');
    expect(sizes).toHaveLength(1);
    expect(Object.keys(sizes[0].specs).sort()).toEqual(
      ['customerPriceHourlyCents', 'customerPriceMonthlyCents', 'diskGb', 'memoryMb', 'vcpus'].sort(),
    );
    expect(JSON.stringify(sizes)).not.toMatch(/providerCost|marginPercent|eur|fx/i);
  });
});
