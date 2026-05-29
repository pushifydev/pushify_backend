import { getPlanInfo, isUnlimited, type PlanLimits, type PlanType } from './plans';
import { LEGACY_PLAN_LIMIT_BONUS } from './legacy-plan-limits';

type OrgLimitFields = {
  plan: PlanType;
  grandfatheredUntil?: Date | null;
  planLimitsOverride?: Partial<Record<string, number | boolean>> | null;
};

function isGrandfatherActive(until: Date | null | undefined): boolean {
  if (!until) return false;
  return until.getTime() > Date.now();
}

function mergeNumericMax(base: number, bonus: number | undefined): number {
  if (bonus === undefined) return base;
  if (isUnlimited(base)) return base;
  if (isUnlimited(bonus)) return bonus;
  return Math.max(base, bonus);
}

function applyLegacyBonus(base: PlanLimits, bonus: Partial<PlanLimits>): PlanLimits {
  return {
    ...base,
    apiRequestsPerMinute: mergeNumericMax(
      base.apiRequestsPerMinute,
      bonus.apiRequestsPerMinute,
    ),
    servers: mergeNumericMax(base.servers, bonus.servers),
    databases: mergeNumericMax(base.databases, bonus.databases),
    projects: mergeNumericMax(base.projects, bonus.projects),
    deploymentsPerMonth: mergeNumericMax(
      base.deploymentsPerMonth,
      bonus.deploymentsPerMonth,
    ),
    teamMembers: mergeNumericMax(base.teamMembers, bonus.teamMembers),
    customDomains: mergeNumericMax(base.customDomains, bonus.customDomains),
    storageGb: mergeNumericMax(base.storageGb, bonus.storageGb),
    bandwidthGb: mergeNumericMax(base.bandwidthGb, bonus.bandwidthGb),
    buildMinutesPerMonth: mergeNumericMax(
      base.buildMinutesPerMonth,
      bonus.buildMinutesPerMonth,
    ),
    snapshotsPerServer: mergeNumericMax(base.snapshotsPerServer, bonus.snapshotsPerServer),
    previewDeployments: bonus.previewDeployments ?? base.previewDeployments,
    healthChecks: bonus.healthChecks ?? base.healthChecks,
    prioritySupport: bonus.prioritySupport ?? base.prioritySupport,
  };
}

function applyOverrides(base: PlanLimits, override: Partial<Record<string, number | boolean>>): PlanLimits {
  const next = { ...base };
  const numericKeys = [
    'apiRequestsPerMinute',
    'servers',
    'databases',
    'projects',
    'deploymentsPerMonth',
    'teamMembers',
    'customDomains',
    'storageGb',
    'bandwidthGb',
    'buildMinutesPerMonth',
    'snapshotsPerServer',
  ] as const;

  for (const key of numericKeys) {
    const val = override[key];
    if (typeof val === 'number') {
      next[key] = val;
    }
  }

  if (typeof override.previewDeployments === 'boolean') {
    next.previewDeployments = override.previewDeployments;
  }
  if (typeof override.healthChecks === 'boolean') {
    next.healthChecks = override.healthChecks;
  }
  if (typeof override.prioritySupport === 'boolean') {
    next.prioritySupport = override.prioritySupport;
  }

  return next;
}

/**
 * Resolve plan limits for an organization (grandfather + optional overrides).
 */
export function getEffectivePlanLimits(org: OrgLimitFields): PlanLimits {
  let limits = { ...getPlanInfo(org.plan).limits };

  if (isGrandfatherActive(org.grandfatheredUntil)) {
    const bonus = LEGACY_PLAN_LIMIT_BONUS[org.plan as keyof typeof LEGACY_PLAN_LIMIT_BONUS];
    if (bonus) {
      limits = applyLegacyBonus(limits, bonus);
    }
  }

  if (org.planLimitsOverride && typeof org.planLimitsOverride === 'object') {
    limits = applyOverrides(limits, org.planLimitsOverride);
  }

  return limits;
}

export function getGrandfatherStatus(org: OrgLimitFields): {
  active: boolean;
  until: string | null;
} {
  const until = org.grandfatheredUntil;
  if (!isGrandfatherActive(until)) {
    return { active: false, until: null };
  }
  return { active: true, until: until!.toISOString() };
}
