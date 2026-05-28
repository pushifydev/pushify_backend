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
  previewDeployments: boolean;
  healthChecks: boolean;
  prioritySupport: boolean;
}

export interface PlanInfo {
  name: string;
  price: number; // Monthly price in USD, 0 for free
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
    limits: {
      apiRequestsPerMinute: 60,
      servers: 0,
      databases: 0,
      projects: 2,
      deploymentsPerMonth: 30,
      teamMembers: 1,
      customDomains: 1,
      storageGb: 1,
      bandwidthGb: 5,
      buildMinutesPerMonth: 30,
      previewDeployments: false,
      healthChecks: false,
      prioritySupport: false,
    },
  },
  hobby: {
    name: 'Hobby',
    price: 10,
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
      previewDeployments: true,
      healthChecks: true,
      prioritySupport: false,
    },
  },
  pro: {
    name: 'Pro',
    price: 25,
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
      previewDeployments: true,
      healthChecks: true,
      prioritySupport: true,
    },
  },
  business: {
    name: 'Business',
    price: 99,
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
      previewDeployments: true,
      healthChecks: true,
      prioritySupport: true,
    },
  },
  enterprise: {
    name: 'Enterprise',
    price: -1, // Custom pricing
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

export function isUnlimited(value: number): boolean {
  return value === -1;
}

export function formatLimit(value: number): string {
  return isUnlimited(value) ? 'Unlimited' : value.toLocaleString();
}
