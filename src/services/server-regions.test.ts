import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ plan: 'hobby' as string }));

vi.mock('../db', () => ({ db: {} }));
vi.mock('../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env')>();
  return { env: { ...actual.env, HETZNER_API_TOKEN: 'test-token' } };
});
vi.mock('../lib/fx-rate', () => ({ getEurToUsdRate: () => 1.16 }));
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: { findById: async () => ({ id: 'org', plan: mocks.plan }) },
}));
// nbg1 while cx23 is sold out there: only cpx12 (EUR 11.49) is small enough, and it is above
// Hobby's cost cap. fsn1 still has cx23.
vi.mock('../providers', () => ({
  createProvider: () => ({
    listRegions: async () => [
      { id: 'nbg1', name: 'Nuremberg (nbg1)', country: 'DE', city: 'Nuremberg', available: true },
      { id: 'fsn1', name: 'Falkenstein (fsn1)', country: 'DE', city: 'Falkenstein', available: true },
      { id: 'ash', name: 'Ashburn (ash)', country: 'US', city: 'Ashburn', available: false },
    ],
    listSizes: async (region: string) =>
      region === 'nbg1'
        ? [{ size: 'xs', specs: { vcpus: 1, memoryMb: 2048, diskGb: 40, priceMonthly: 11.49, serverType: 'cpx12' } }]
        : [{ size: 'xs', specs: { vcpus: 2, memoryMb: 4096, diskGb: 40, priceMonthly: 5.49, serverType: 'cx23' } }],
  }),
}));

import { serverService } from './server.service';

describe('serverService.getRegions for an organization', () => {
  it('marks regions where the plan can create nothing', async () => {
    mocks.plan = 'hobby';
    const regions = await serverService.getRegions('hetzner', 'en', 'org');
    expect(regions.map((r) => [r.id, r.availableForPlan])).toEqual([
      ['nbg1', false],
      ['fsn1', true],
      ['ash', false],
    ]);
  });

  it('opens nbg1 to plans whose limits allow cpx12', async () => {
    mocks.plan = 'pro';
    const regions = await serverService.getRegions('hetzner', 'en', 'org');
    expect(regions.find((r) => r.id === 'nbg1')?.availableForPlan).toBe(true);
  });

  it('leaves the list untouched without an organization', async () => {
    const regions = await serverService.getRegions('hetzner', 'en');
    expect(regions.every((r) => !('availableForPlan' in r))).toBe(true);
  });
});
