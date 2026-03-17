// Plan types matching the database enum
export type PlanType = 'free' | 'hobby' | 'pro' | 'business' | 'enterprise';

export interface PlanLimits {
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

export const PLAN_LIMITS: Record<PlanType, PlanInfo> = {
  free: {
    name: 'Free',
    price: 0,
    limits: {
      servers: 0, // No servers on free plan
      databases: 0, // No databases on free plan
      projects: 3,
      deploymentsPerMonth: 100,
      teamMembers: 1,
      customDomains: 1,
      storageGb: 1,
      bandwidthGb: 10,
      buildMinutesPerMonth: 100,
      previewDeployments: false,
      healthChecks: false,
      prioritySupport: false,
    },
  },
  hobby: {
    name: 'Hobby',
    price: 10,
    limits: {
      servers: 1,
      databases: 2,
      projects: 10,
      deploymentsPerMonth: 500,
      teamMembers: 3,
      customDomains: 5,
      storageGb: 10,
      bandwidthGb: 100,
      buildMinutesPerMonth: 500,
      previewDeployments: true,
      healthChecks: true,
      prioritySupport: false,
    },
  },
  pro: {
    name: 'Pro',
    price: 25,
    limits: {
      servers: 3,
      databases: 5,
      projects: 50,
      deploymentsPerMonth: 2000,
      teamMembers: 10,
      customDomains: 20,
      storageGb: 50,
      bandwidthGb: 500,
      buildMinutesPerMonth: 2000,
      previewDeployments: true,
      healthChecks: true,
      prioritySupport: true,
    },
  },
  business: {
    name: 'Business',
    price: 99,
    limits: {
      servers: 10,
      databases: 20,
      projects: 200,
      deploymentsPerMonth: 10000,
      teamMembers: 50,
      customDomains: 100,
      storageGb: 200,
      bandwidthGb: 2000,
      buildMinutesPerMonth: 10000,
      previewDeployments: true,
      healthChecks: true,
      prioritySupport: true,
    },
  },
  enterprise: {
    name: 'Enterprise',
    price: -1, // Custom pricing
    limits: {
      servers: -1, // Unlimited
      databases: -1, // Unlimited
      projects: -1, // Unlimited
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

export function isUnlimited(value: number): boolean {
  return value === -1;
}

export function formatLimit(value: number): string {
  return isUnlimited(value) ? 'Unlimited' : value.toLocaleString();
}
