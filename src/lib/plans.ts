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
  /** How many days of container logs are kept and searchable */
  logRetentionDays: number;
  /**
   * The shortest gap allowed between automatic database backups. It is a floor, not a schedule:
   * the customer picks the interval, this is how often they are allowed to pick. Worth charging
   * for because it is the difference between losing a day of data and losing an hour.
   */
  minBackupIntervalHours: number;
  /** Scale containers on load instead of by hand */
  autoscaling: boolean;
  previewDeployments: boolean;
  healthChecks: boolean;
  prioritySupport: boolean;
}

export interface PlanInfo {
  name: string;
  price: number; // Monthly price in USD, 0 for free
  /**
   * Managed-server credit included every month (USD cents), fixed per plan. Kept in its own
   * balance, spent before the wallet, servers only, no roll-over; yearly plans get it monthly.
   * See lib/included-credit.ts and services/included-credit.service.ts.
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
      logRetentionDays: 3,
      minBackupIntervalHours: 24,
      autoscaling: false,
      previewDeployments: false,
      healthChecks: false,
      prioritySupport: false,
    },
  },
  hobby: {
    name: 'Hobby',
    price: 15,
    includedInfraCreditCents: 900, // $9 — covers the entry server (cx23 ≈ $7.65 at ~1.16 EUR/USD) up to ~1.36
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
      logRetentionDays: 7,
      minBackupIntervalHours: 12,
      autoscaling: false,
      previewDeployments: true,
      healthChecks: true,
      prioritySupport: false,
    },
  },
  pro: {
    name: 'Pro',
    price: 29,
    includedInfraCreditCents: 1800, // $18
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
      logRetentionDays: 14,
      minBackupIntervalHours: 6,
      autoscaling: true,
      previewDeployments: true,
      healthChecks: true,
      prioritySupport: true,
    },
  },
  business: {
    name: 'Business',
    price: 99,
    includedInfraCreditCents: 4500, // $45
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
      logRetentionDays: 30,
      minBackupIntervalHours: 1,
      autoscaling: true,
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
      logRetentionDays: 90,
      minBackupIntervalHours: 1,
      autoscaling: true,
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
