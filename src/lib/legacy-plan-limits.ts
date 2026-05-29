import type { PlanLimits, PlanType } from './plans';

/** Pre–limit-tightening caps applied while grandfatheredUntil is active */
export const LEGACY_PLAN_LIMIT_BONUS: Partial<
  Record<Exclude<PlanType, 'free' | 'enterprise'>, Partial<PlanLimits>>
> = {
  hobby: {
    servers: 2,
    databases: 2,
    projects: 10,
    deploymentsPerMonth: 300,
    teamMembers: 3,
    customDomains: 5,
    storageGb: 10,
    bandwidthGb: 100,
    buildMinutesPerMonth: 500,
    snapshotsPerServer: 5,
  },
  pro: {
    servers: 5,
    databases: 5,
    projects: 30,
    deploymentsPerMonth: 1500,
    teamMembers: 8,
    customDomains: 20,
    storageGb: 50,
    bandwidthGb: 500,
    buildMinutesPerMonth: 1500,
  },
  business: {
    servers: 15,
    databases: 20,
    projects: 100,
    deploymentsPerMonth: 5000,
    teamMembers: 25,
    customDomains: 50,
    storageGb: 200,
    bandwidthGb: 2000,
    buildMinutesPerMonth: 5000,
    snapshotsPerServer: 20,
  },
};
