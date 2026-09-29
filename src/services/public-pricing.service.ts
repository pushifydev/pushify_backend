import { env } from '../config/env';
import { createProvider } from '../providers';
import type { ServerSize } from '../providers/cloud-provider.interface';
import { assertServerWithinPlanLimits, buildPriceQuote } from '../lib/infra-billing';
import type { PlanType } from '../lib/plans';
import { logger } from '../lib/logger';

/**
 * Managed-server prices for the public pricing page.
 *
 * Only what a customer pays leaves this module: no provider cost, exchange rate or margin.
 * The provider catalogue is cached per region so an anonymous endpoint cannot turn into a
 * stream of Hetzner API calls; concurrent misses share one in-flight request.
 */

export const PUBLIC_PRICE_REGIONS = ['fsn1', 'nbg1', 'hel1'] as const;
export type PublicPriceRegion = (typeof PUBLIC_PRICE_REGIONS)[number];

export interface PublicServerPrice {
  size: Exclude<ServerSize, 'custom'>;
  serverType: string;
  vcpus: number;
  memoryGb: number;
  diskGb: number;
  /** USD per hour, 4 decimals — a small server costs well under a cent an hour. */
  priceHourlyUsd: number;
  priceMonthlyCents: number;
  /** Cheapest self-serve plan that allows this server. */
  minPlan: Exclude<PlanType, 'free' | 'enterprise'> | 'enterprise';
}

export interface PublicServerPrices {
  region: PublicPriceRegion;
  currency: 'USD';
  hoursPerMonth: 730;
  updatedAt: string;
  servers: PublicServerPrice[];
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const PLAN_ORDER = ['hobby', 'pro', 'business'] as const;

const cache = new Map<PublicPriceRegion, { at: number; value: PublicServerPrices }>();
const inFlight = new Map<PublicPriceRegion, Promise<PublicServerPrices>>();

export function isPublicPriceRegion(region: string): region is PublicPriceRegion {
  return (PUBLIC_PRICE_REGIONS as readonly string[]).includes(region);
}

function minPlanFor(specs: { vcpus: number; memoryMb: number; diskGb: number }, providerCostMonthlyCents: number) {
  for (const plan of PLAN_ORDER) {
    try {
      assertServerWithinPlanLimits(plan, specs, providerCostMonthlyCents);
      return plan;
    } catch {
      // too large for this plan; try the next one
    }
  }
  return 'enterprise' as const;
}

async function load(region: PublicPriceRegion): Promise<PublicServerPrices> {
  const token = env.HETZNER_API_TOKEN;
  if (!token) throw new Error('HETZNER_API_TOKEN is not configured');

  const sizes = await createProvider('hetzner', token).listSizes(region);
  const servers: PublicServerPrice[] = [];
  for (const entry of sizes) {
    if (entry.size === 'custom') continue;
    const specs = { vcpus: entry.specs.vcpus, memoryMb: entry.specs.memoryMb, diskGb: entry.specs.diskGb };
    const quote = buildPriceQuote(entry.specs.priceMonthly, entry.specs.priceMonthly / 730, specs);
    servers.push({
      size: entry.size,
      serverType: entry.specs.serverType ?? '',
      vcpus: specs.vcpus,
      memoryGb: Math.round(specs.memoryMb / 1024),
      diskGb: specs.diskGb,
      priceHourlyUsd: Math.round((quote.customerPriceMonthlyCents / 730 / 100) * 10000) / 10000,
      priceMonthlyCents: quote.customerPriceMonthlyCents,
      minPlan: minPlanFor(specs, quote.providerCostMonthlyCents),
    });
  }
  servers.sort((a, b) => a.priceMonthlyCents - b.priceMonthlyCents);

  return { region, currency: 'USD', hoursPerMonth: 730, updatedAt: new Date().toISOString(), servers };
}

export const publicPricingService = {
  async getManagedServerPrices(region: PublicPriceRegion, now: number = Date.now()): Promise<PublicServerPrices> {
    const hit = cache.get(region);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;

    let pending = inFlight.get(region);
    if (!pending) {
      pending = load(region)
        .then((value) => {
          cache.set(region, { at: Date.now(), value });
          return value;
        })
        .catch((err) => {
          logger.warn({ err, region }, 'Public managed-server prices unavailable');
          // Serve the last good answer rather than failing the pricing page.
          if (hit) return hit.value;
          throw err;
        })
        .finally(() => inFlight.delete(region));
      inFlight.set(region, pending);
    }
    return pending;
  },

  /** Test hook. */
  clearCache() {
    cache.clear();
    inFlight.clear();
  },
};
