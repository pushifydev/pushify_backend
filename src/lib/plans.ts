// Plan types matching the database enum
export type PlanType = 'free' | 'hobby' | 'pro' | 'business' | 'enterprise';

export interface PlanLimits {
  /** Authenticated API requests per minute (per API key or org). -1 = unlimited */
  apiRequestsPerMinute: number;
  servers: number;
  databases: number;
  projects: number;
  deploymentsPerMonth: number;
  teamMembers: number;
  customDomains: number;
  storageGb: number;
  bandwidthGb: number;
  buildMinutesPerMonth: number;
  /** Max Hetzner snapshots retained per managed server (-1 = unlimited) */
  snapshotsPerServer: number;
  previewDeployments: boolean;
  healthChecks: boolean;
  prioritySupport: boolean;
}

export interface PlanInfo {
  name: string;
  price: number; // Monthly price in USD, 0 for free
  /**
   * Upper bound (USD cents) for the managed-infra compute credit included with the plan.
   * The ACTUAL granted amount is dynamic: it tracks the cheapest plan-eligible server's
   * current price (FX-adjusted) plus a small headroom, capped at this ceiling — so a paying
   * customer can always start their entry server without a separate top-up even as Hetzner/FX
   * prices move. Kept below the plan's net margin so we never lose money. See
   * grantIncludedInfraCredit() / computeIncludedCreditTargetCents().
   */
  includedInfraCreditCents: number;
  limits: PlanLimits;
}

/**
 * Platform limits (v2 — profit-oriented).
 * Managed server compute is billed separately via the infra wallet (+ margin).
 */
export const PLAN_LIMITS: Record<PlanType, PlanInfo> = {
  free: {
    name: 'Free',
    price: 0,
    includedInfraCreditCents: 0,
    limits: {
      apiRequestsPerMinute: 60,
      // Free tier can connect ONE BYO server (their VPS, their cost) so the product is
      // actually try-able before paying. Managed (Hetzner) servers stay paid-only —
      // enforced separately via PLAN_INFRA_LIMITS.free.managedServersEnabled = false.
      servers: 1,
      databases: 1,
      projects: 2,
      deploymentsPerMonth: 30,
      teamMembers: 1,
      customDomains: 1,
      storageGb: 5,
      bandwidthGb: 5,
      buildMinutesPerMonth: 30,
      snapshotsPerServer: 0,
      previewDeployments: false,
      healthChecks: false,
      prioritySupport: false,
    },
  },
  hobby: {
    name: 'Hobby',
    price: 15,
    includedInfraCreditCents: 900, // ceiling ~$9 — dynamic grant covers the cheapest server (~$6.5-7.5); < $15 margin
    limits: {
      apiRequestsPerMinute: 120,
      servers: 1,
      databases: 1,
      projects: 5,
      deploymentsPerMonth: 150,
      teamMembers: 2,
      customDomains: 2,
      storageGb: 5,
      bandwidthGb: 50,
      buildMinutesPerMonth: 200,
      snapshotsPerServer: 2,
      previewDeployments: true,
      healthChecks: true,
      prioritySupport: false,
    },
  },
  pro: {
    name: 'Pro',
    price: 29,
    includedInfraCreditCents: 2000, // ceiling ~$20 — dynamic grant covers the cheapest eligible server; < $29 margin
    limits: {
      apiRequestsPerMinute: 300,
      servers: 3,
      databases: 3,
      projects: 15,
      deploymentsPerMonth: 750,
      teamMembers: 5,
      customDomains: 10,
      storageGb: 25,
      bandwidthGb: 250,
      buildMinutesPerMonth: 750,
      snapshotsPerServer: 5,
      previewDeployments: true,
      healthChecks: true,
      prioritySupport: true,
    },
  },
  business: {
    name: 'Business',
    price: 99,
    includedInfraCreditCents: 5000, // ceiling ~$50 — dynamic grant covers the cheapest eligible server; well under $99
    limits: {
      apiRequestsPerMinute: 600,
      servers: 8,
      databases: 10,
      projects: 50,
      deploymentsPerMonth: 3000,
      teamMembers: 15,
      customDomains: 25,
      storageGb: 100,
      bandwidthGb: 1000,
      buildMinutesPerMonth: 3000,
      snapshotsPerServer: 10,
      previewDeployments: true,
      healthChecks: true,
      prioritySupport: true,
    },
  },
  enterprise: {
    name: 'Enterprise',
    price: -1, // Custom pricing
    includedInfraCreditCents: 0, // billed separately; enterprise infra is not wallet-metered
    limits: {
      apiRequestsPerMinute: -1,
      servers: -1,
      databases: -1,
      projects: -1,
      deploymentsPerMonth: -1,
      teamMembers: -1,
      customDomains: -1,
      storageGb: -1,
      bandwidthGb: -1,
      buildMinutesPerMonth: -1,
      snapshotsPerServer: -1,
      previewDeployments: true,
      healthChecks: true,
      prioritySupport: true,
    },
  },
};

export function getPlanInfo(plan: PlanType): PlanInfo {
  return PLAN_LIMITS[plan];
}

export function getApiRequestsPerMinute(plan: PlanType): number {
  return getPlanInfo(plan).limits.apiRequestsPerMinute;
}

export function getIncludedInfraCreditCents(plan: PlanType): number {
  return getPlanInfo(plan).includedInfraCreditCents;
}

export function isUnlimited(value: number): boolean {
  return value === -1;
}

export function formatLimit(value: number): string {
  return isUnlimited(value) ? 'Unlimited' : value.toLocaleString();
}
