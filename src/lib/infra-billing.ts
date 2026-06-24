import { env } from '../config/env';
import { getEurToUsdRate } from './fx-rate';
import { getPlanInfo, isUnlimited, type PlanType } from './plans';

/** Pushify margin on top of provider list price (e.g. 20 = 20%) */
export const INFRA_MARGIN_PERCENT = env.INFRA_MARGIN_PERCENT;

/** EUR → USD floor/fallback rate. Live rate is fetched dynamically — see lib/fx-rate.ts */
export const INFRA_EUR_TO_USD_RATE = env.INFRA_EUR_TO_USD_RATE;

/** Flat per-server surcharge (EUR) added before margin to cover provider extras like IPv4 */
const INFRA_PROVIDER_SURCHARGE_EUR = env.INFRA_PROVIDER_SURCHARGE_EUR;

export interface PlanInfraLimits {
  managedServersEnabled: boolean;
  maxServerVcpus: number;
  maxServerMemoryMb: number;
  /** Max provider monthly cost per server in USD cents (before margin). -1 = unlimited */
  maxProviderMonthlyUsdCents: number;
}

export const PLAN_INFRA_LIMITS: Record<PlanType, PlanInfraLimits> = {
  free: {
    managedServersEnabled: false,
    maxServerVcpus: 0,
    maxServerMemoryMb: 0,
    maxProviderMonthlyUsdCents: 0,
  },
  hobby: {
    managedServersEnabled: true,
    maxServerVcpus: 2,
    maxServerMemoryMb: 4096,
    maxProviderMonthlyUsdCents: 1200, // ~$12/mo provider cap before margin
  },
  pro: {
    managedServersEnabled: true,
    maxServerVcpus: 4,
    maxServerMemoryMb: 8192,
    maxProviderMonthlyUsdCents: 3500,
  },
  business: {
    managedServersEnabled: true,
    maxServerVcpus: 8,
    maxServerMemoryMb: 32768,
    maxProviderMonthlyUsdCents: 10000,
  },
  enterprise: {
    managedServersEnabled: true,
    maxServerVcpus: -1,
    maxServerMemoryMb: -1,
    maxProviderMonthlyUsdCents: -1,
  },
};

export function getPlanInfraLimits(plan: PlanType): PlanInfraLimits {
  return PLAN_INFRA_LIMITS[plan];
}

export function eurToUsdCents(eurAmount: number): number {
  return Math.round(eurAmount * getEurToUsdRate() * 100);
}

/** Provider cost (USD cents) → customer price with margin (USD cents) */
export function applyInfraMargin(providerUsdCents: number): number {
  return Math.ceil(providerUsdCents * (1 + INFRA_MARGIN_PERCENT / 100));
}

export function providerMonthlyToHourlyCents(providerMonthlyUsdCents: number): number {
  return Math.max(1, Math.ceil(providerMonthlyUsdCents / 730));
}

export interface ServerSpecsQuote {
  vcpus: number;
  memoryMb: number;
  diskGb: number;
  providerServerType?: string;
}

export interface InfraPriceQuote {
  providerCostMonthlyCents: number;
  providerCostHourlyCents: number;
  customerPriceMonthlyCents: number;
  customerPriceHourlyCents: number;
  marginPercent: number;
  specs: ServerSpecsQuote;
}

export function buildPriceQuote(
  providerMonthlyEur: number,
  providerHourlyEur: number,
  specs: ServerSpecsQuote,
): InfraPriceQuote {
  // Add the flat extras surcharge (e.g. IPv4) to the provider cost before margin.
  const providerCostMonthlyCents = eurToUsdCents(providerMonthlyEur + INFRA_PROVIDER_SURCHARGE_EUR);
  const providerCostHourlyCents =
    providerHourlyEur > 0
      ? eurToUsdCents(providerHourlyEur + INFRA_PROVIDER_SURCHARGE_EUR / 730)
      : providerMonthlyToHourlyCents(providerCostMonthlyCents);

  const customerPriceMonthlyCents = applyInfraMargin(providerCostMonthlyCents);
  const customerPriceHourlyCents = applyInfraMargin(providerCostHourlyCents);

  return {
    providerCostMonthlyCents,
    providerCostHourlyCents,
    customerPriceMonthlyCents,
    customerPriceHourlyCents,
    marginPercent: INFRA_MARGIN_PERCENT,
    specs,
  };
}

export function assertServerWithinPlanLimits(
  plan: PlanType,
  specs: ServerSpecsQuote,
  providerMonthlyUsdCents: number,
): void {
  const limits = getPlanInfraLimits(plan);
  const planInfo = getPlanInfo(plan);

  if (!limits.managedServersEnabled || planInfo.limits.servers === 0) {
    throw new Error('PLAN_NO_MANAGED_SERVERS');
  }

  if (!isUnlimited(limits.maxServerVcpus) && specs.vcpus > limits.maxServerVcpus) {
    throw new Error('PLAN_SERVER_VCPU_EXCEEDED');
  }

  if (!isUnlimited(limits.maxServerMemoryMb) && specs.memoryMb > limits.maxServerMemoryMb) {
    throw new Error('PLAN_SERVER_MEMORY_EXCEEDED');
  }

  if (
    !isUnlimited(limits.maxProviderMonthlyUsdCents) &&
    providerMonthlyUsdCents > limits.maxProviderMonthlyUsdCents
  ) {
    throw new Error('PLAN_SERVER_PRICE_EXCEEDED');
  }
}

/** Minimum wallet balance required to provision (≈ one month at customer rate) */
export function minimumWalletBalanceForQuote(quote: InfraPriceQuote): number {
  return quote.customerPriceMonthlyCents;
}

export const INFRA_TOPUP_AMOUNTS_CENTS = [2500, 5000, 10000, 25000, 50000] as const;

/** Send low-balance warning when wallet drops below this (USD cents) */
export const INFRA_LOW_BALANCE_WARN_CENTS = env.INFRA_LOW_BALANCE_WARN_CENTS;
