import { HTTPException } from 'hono/http-exception';
import type Stripe from 'stripe';
import { env } from '../config/env';
import { getStripe } from '../lib/stripe';
import { organizationRepository } from '../repositories/organization.repository';
import { PLAN_LIMITS, getPlanInfo, isUnlimited, type PlanLimits, type PlanType } from '../lib/plans';
import { getGrandfatherStatus } from '../lib/effective-plan-limits';
import { t, type SupportedLocale } from '../i18n';
import { planLimitsService } from './plan-limits.service';
import { usageMeteringService } from './usage-metering.service';

export interface UsageItem {
  used: number;
  /** Enforced limit (grandfather / overrides applied) */
  limit: number;
  /** Subscribed plan limit when it differs from `limit` */
  planLimit?: number;
  unlimited: boolean;
}

export type UsageStats = Record<
  | 'servers'
  | 'databases'
  | 'projects'
  | 'deploymentsThisMonth'
  | 'teamMembers'
  | 'customDomains'
  | 'buildMinutesThisMonth'
  | 'storageGb'
  | 'bandwidthGb',
  UsageItem
>;

export type UsageLimitKey = keyof UsageStats;

const USAGE_LIMIT_KEYS: UsageLimitKey[] = [
  'servers',
  'databases',
  'projects',
  'deploymentsThisMonth',
  'buildMinutesThisMonth',
  'storageGb',
  'bandwidthGb',
  'teamMembers',
  'customDomains',
];

function buildUsageItem(used: number, effective: number, plan: number): UsageItem {
  const unlimited = isUnlimited(effective);
  const item: UsageItem = { used, limit: effective, unlimited };
  if (!unlimited && !isUnlimited(plan) && plan !== effective) {
    item.planLimit = plan;
  }
  return item;
}

const USAGE_TO_PLAN_LIMIT_KEY: Record<UsageLimitKey, keyof PlanLimits> = {
  servers: 'servers',
  databases: 'databases',
  projects: 'projects',
  deploymentsThisMonth: 'deploymentsPerMonth',
  buildMinutesThisMonth: 'buildMinutesPerMonth',
  storageGb: 'storageGb',
  bandwidthGb: 'bandwidthGb',
  teamMembers: 'teamMembers',
  customDomains: 'customDomains',
};

function getBoostedUsageKeys(planLimits: PlanLimits, effectiveLimits: PlanLimits): UsageLimitKey[] {
  const boosted: UsageLimitKey[] = [];
  for (const key of USAGE_LIMIT_KEYS) {
    const planKey = USAGE_TO_PLAN_LIMIT_KEY[key];
    const base = planLimits[planKey] as number;
    const effective = effectiveLimits[planKey] as number;
    if (isUnlimited(effective) && !isUnlimited(base)) {
      boosted.push(key);
    } else if (!isUnlimited(effective) && effective > base) {
      boosted.push(key);
    }
  }
  return boosted;
}

export interface GrandfatherInfo {
  active: boolean;
  until: string | null;
  /** Usage keys with limits above the subscribed plan (while grandfather is active) */
  boostedResources: UsageLimitKey[];
}

export interface BillingInfo {
  plan: PlanType;
  planName: string;
  price: number;
  billingStatus: 'active' | 'past_due' | 'suspended';
  billingEmail: string | null;
  /** API requests per minute per API key (org plan). -1 = unlimited */
  apiRequestsPerMinute: number;
  usage: UsageStats;
  features: {
    previewDeployments: boolean;
    healthChecks: boolean;
    prioritySupport: boolean;
  };
  grandfather: GrandfatherInfo;
}

export const billingService = {
  /**
   * Get billing information for an organization
   */
  /**
   * Stripe invoice history for the organization (owner/admin sees it in Billing).
   * Returns [] when Stripe isn't configured or the org has no customer yet.
   */
  async listInvoices(organizationId: string, userId: string, locale: SupportedLocale = 'en') {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    const org = await organizationRepository.findById(organizationId);
    if (!org?.stripeCustomerId || !env.STRIPE_SECRET_KEY) {
      return [];
    }

    const stripe = getStripe();
    const invoices = await stripe.invoices.list({
      customer: org.stripeCustomerId,
      limit: 24,
    });

    return invoices.data.map((inv: Stripe.Invoice) => ({
      id: inv.id,
      number: inv.number,
      createdAt: new Date(inv.created * 1000).toISOString(),
      amountDueCents: inv.amount_due,
      amountPaidCents: inv.amount_paid,
      currency: inv.currency,
      status: inv.status,
      hostedInvoiceUrl: inv.hosted_invoice_url,
      invoicePdf: inv.invoice_pdf,
    }));
  },

  async getBillingInfo(
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ): Promise<BillingInfo> {
    // Verify access
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Get organization
    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HTTPException(404, { message: t(locale, 'organizations', 'notFound') });
    }

    const plan = (org.plan || 'free') as PlanType;
    const planInfo = getPlanInfo(plan);
    const planLimits = planInfo.limits;
    const effectiveLimits = await planLimitsService.getEffectiveLimits(organizationId);

    const usage = await this.getUsageStats(organizationId, effectiveLimits, planLimits);
    const grandfatherStatus = getGrandfatherStatus({
      plan,
      grandfatheredUntil: org.grandfatheredUntil,
    });
    const boostedResources = grandfatherStatus.active
      ? getBoostedUsageKeys(planLimits, effectiveLimits)
      : [];
    const grandfather: GrandfatherInfo = {
      ...grandfatherStatus,
      boostedResources,
    };

    return {
      plan,
      planName: planInfo.name,
      price: planInfo.price,
      billingStatus: (org.billingStatus ?? 'active') as BillingInfo['billingStatus'],
      billingEmail: org.billingEmail,
      apiRequestsPerMinute: effectiveLimits.apiRequestsPerMinute,
      usage,
      features: {
        previewDeployments: effectiveLimits.previewDeployments,
        healthChecks: effectiveLimits.healthChecks,
        prioritySupport: effectiveLimits.prioritySupport,
      },
      grandfather,
    };
  },

  /**
   * Get usage statistics for an organization
   */
  async getUsageStats(
    organizationId: string,
    effectiveLimits?: PlanLimits,
    planLimits?: PlanLimits,
  ): Promise<UsageStats> {
    const effective =
      effectiveLimits ?? (await planLimitsService.getEffectiveLimits(organizationId));
    const plan =
      planLimits ??
      getPlanInfo(
        ((await organizationRepository.findById(organizationId))?.plan || 'free') as PlanType,
      ).limits;

    const [
      serverCount,
      databaseCount,
      projectCount,
      deploymentCount,
      memberCount,
      domainCount,
      buildMinutes,
      metered,
    ] = await Promise.all([
      planLimitsService.countServers(organizationId),
      planLimitsService.countDatabases(organizationId),
      planLimitsService.countProjects(organizationId),
      planLimitsService.countDeploymentsThisMonth(organizationId),
      planLimitsService.countTeamMembers(organizationId),
      planLimitsService.countCustomDomains(organizationId),
      planLimitsService.countBuildMinutesThisMonth(organizationId),
      usageMeteringService.getMonthlyUsageGb(organizationId),
    ]);

    return {
      servers: buildUsageItem(serverCount, effective.servers, plan.servers),
      databases: buildUsageItem(databaseCount, effective.databases, plan.databases),
      projects: buildUsageItem(projectCount, effective.projects, plan.projects),
      deploymentsThisMonth: buildUsageItem(
        deploymentCount,
        effective.deploymentsPerMonth,
        plan.deploymentsPerMonth,
      ),
      teamMembers: buildUsageItem(memberCount, effective.teamMembers, plan.teamMembers),
      customDomains: buildUsageItem(domainCount, effective.customDomains, plan.customDomains),
      buildMinutesThisMonth: buildUsageItem(
        buildMinutes,
        effective.buildMinutesPerMonth,
        plan.buildMinutesPerMonth,
      ),
      storageGb: buildUsageItem(metered.storageGb, effective.storageGb, plan.storageGb),
      bandwidthGb: buildUsageItem(metered.bandwidthGb, effective.bandwidthGb, plan.bandwidthGb),
    };
  },

  /**
   * Update billing email
   */
  async updateBillingEmail(
    organizationId: string,
    userId: string,
    billingEmail: string,
    locale: SupportedLocale = 'en'
  ) {
    // Verify access - only owner can update billing email
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    if (membership.role !== 'owner') {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }

    const updated = await organizationRepository.update(organizationId, { billingEmail });
    return updated;
  },

  /**
   * Get all available plans
   */
  getAvailablePlans() {
    return PLAN_LIMITS;
  },
};
