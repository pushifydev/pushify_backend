import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ listSizes: vi.fn() }));

vi.mock('../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env')>();
  return { env: { ...actual.env, HETZNER_API_TOKEN: 'test-token' } };
});
vi.mock('../lib/fx-rate', () => ({ getEurToUsdRate: () => 1.1 }));
// Keep rate-limit counters in memory so a local Redis cannot carry them across runs.
vi.mock('../lib/redis-client', () => ({ getOptionalRedis: () => null }));
vi.mock('../providers', () => ({ createProvider: () => ({ listSizes: mocks.listSizes }) }));

import { publicPricingService } from './public-pricing.service';
import { publicPricingRoutes } from '../routes/public-pricing';

const SIZES = [
  { size: 'md', specs: { vcpus: 4, memoryMb: 8192, diskGb: 160, priceMonthly: 15.9, serverType: 'cx33' } },
  { size: 'xs', specs: { vcpus: 2, memoryMb: 4096, diskGb: 40, priceMonthly: 4.99, serverType: 'cx23' } },
];

beforeEach(() => {
  publicPricingService.clearCache();
  mocks.listSizes.mockReset().mockResolvedValue(SIZES);
});

describe('publicPricingService.getManagedServerPrices', () => {
  it('returns customer prices only, cheapest first, with the minimum plan', async () => {
    const res = await publicPricingService.getManagedServerPrices('fsn1');
    expect(res.servers.map((s) => s.serverType)).toEqual(['cx23', 'cx33']);
    expect(res.servers[0].minPlan).toBe('hobby');
    expect(res.servers[1].minPlan).toBe('pro');
    for (const s of res.servers) {
      expect(Object.keys(s).sort()).toEqual(
        ['diskGb', 'memoryGb', 'minPlan', 'priceHourlyUsd', 'priceMonthlyCents', 'serverType', 'size', 'vcpus'].sort(),
      );
      expect(s.priceMonthlyCents).toBeGreaterThan(0);
      expect(s.priceHourlyUsd).toBeCloseTo(s.priceMonthlyCents / 730 / 100, 4);
    }
    const json = JSON.stringify(res);
    expect(json).not.toMatch(/provider|margin|eur|fx/i);
  });

  it('caches per region for an hour and shares concurrent misses', async () => {
    await Promise.all([
      publicPricingService.getManagedServerPrices('fsn1'),
      publicPricingService.getManagedServerPrices('fsn1'),
    ]);
    await publicPricingService.getManagedServerPrices('fsn1');
    expect(mocks.listSizes).toHaveBeenCalledTimes(1);

    await publicPricingService.getManagedServerPrices('fsn1', Date.now() + 61 * 60 * 1000);
    expect(mocks.listSizes).toHaveBeenCalledTimes(2);
  });

  it('serves the last good answer when the provider fails, and throws with no cache', async () => {
    const first = await publicPricingService.getManagedServerPrices('fsn1');
    mocks.listSizes.mockRejectedValue(new Error('hetzner down'));
    const stale = await publicPricingService.getManagedServerPrices('fsn1', Date.now() + 2 * 60 * 60 * 1000);
    expect(stale).toEqual(first);
    await expect(publicPricingService.getManagedServerPrices('hel1')).rejects.toThrow('hetzner down');
  });
});

describe('GET /managed-server-prices', () => {
  it('rejects unknown regions', async () => {
    const res = await publicPricingRoutes.request('/managed-server-prices?region=us-east');
    expect(res.status).toBe(400);
  });

  it('returns prices with a shared-cache header', async () => {
    const res = await publicPricingRoutes.request('/managed-server-prices');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('s-maxage=3600');
    const body = (await res.json()) as { data: { region: string; servers: unknown[] } };
    expect(body.data.region).toBe('fsn1');
    expect(body.data.servers).toHaveLength(2);
  });

  it('answers 503 when prices cannot be loaded', async () => {
    mocks.listSizes.mockRejectedValue(new Error('hetzner down'));
    const res = await publicPricingRoutes.request('/managed-server-prices?region=nbg1');
    expect(res.status).toBe(503);
  });

  it('rate limits a single client', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) {
      statuses.push((await publicPricingRoutes.request('/managed-server-prices?region=hel1')).status);
    }
    expect(statuses).toContain(429);
  });
});
