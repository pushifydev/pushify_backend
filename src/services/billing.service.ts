import { HTTPException } from 'hono/http-exception';
import { eq, and, gte, sql, count } from 'drizzle-orm';
import { db } from '../db';
import { deployments } from '../db/schema/deployments';
import { projects, domains } from '../db/schema/projects';
import { organizationMembers } from '../db/schema/organizations';
import { servers } from '../db/schema/servers';
import { databases } from '../db/schema/databases';
import { organizationRepository } from '../repositories/organization.repository';
import { PLAN_LIMITS, getPlanInfo, isUnlimited, type PlanType } from '../lib/plans';
import { t, type SupportedLocale } from '../i18n';

export interface UsageStats {
  servers: {
    used: number;
    limit: number;
    unlimited: boolean;
  };
  databases: {
    used: number;
    limit: number;
    unlimited: boolean;
  };
  projects: {
    used: number;
    limit: number;
    unlimited: boolean;
  };
  deploymentsThisMonth: {
    used: number;
    limit: number;
    unlimited: boolean;
  };
  teamMembers: {
    used: number;
    limit: number;
    unlimited: boolean;
  };
  customDomains: {
    used: number;
    limit: number;
    unlimited: boolean;
  };
}

export interface BillingInfo {
  plan: PlanType;
  planName: string;
  price: number;
  billingEmail: string | null;
  usage: UsageStats;
  features: {
    previewDeployments: boolean;
    healthChecks: boolean;
    prioritySupport: boolean;
  };
}

export const billingService = {
  /**
   * Get billing information for an organization
   */
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

    // Get usage stats
    const usage = await this.getUsageStats(organizationId, plan);

    return {
      plan,
      planName: planInfo.name,
      price: planInfo.price,
      billingEmail: org.billingEmail,
      usage,
      features: {
        previewDeployments: planInfo.limits.previewDeployments,
        healthChecks: planInfo.limits.healthChecks,
        prioritySupport: planInfo.limits.prioritySupport,
      },
    };
  },

  /**
   * Get usage statistics for an organization
   */
  async getUsageStats(organizationId: string, plan: PlanType): Promise<UsageStats> {
    const planInfo = getPlanInfo(plan);
    const limits = planInfo.limits;

    // Get first day of current month
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Count servers
    const serversResult = await db
      .select({ count: count() })
      .from(servers)
      .where(eq(servers.organizationId, organizationId));
    const serverCount = serversResult[0]?.count || 0;

    // Count databases
    const databasesResult = await db
      .select({ count: count() })
      .from(databases)
      .where(eq(databases.organizationId, organizationId));
    const databaseCount = databasesResult[0]?.count || 0;

    // Count projects
    const projectsResult = await db
      .select({ count: count() })
      .from(projects)
      .where(eq(projects.organizationId, organizationId));
    const projectCount = projectsResult[0]?.count || 0;

    // Count deployments this month
    const deploymentsResult = await db
      .select({ count: count() })
      .from(deployments)
      .innerJoin(projects, eq(deployments.projectId, projects.id))
      .where(
        and(
          eq(projects.organizationId, organizationId),
          gte(deployments.createdAt, firstDayOfMonth)
        )
      );
    const deploymentCount = deploymentsResult[0]?.count || 0;

    // Count team members
    const membersResult = await db
      .select({ count: count() })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, organizationId));
    const memberCount = membersResult[0]?.count || 0;

    // Count custom domains
    const domainsResult = await db
      .select({ count: count() })
      .from(domains)
      .innerJoin(projects, eq(domains.projectId, projects.id))
      .where(eq(projects.organizationId, organizationId));
    const domainCount = domainsResult[0]?.count || 0;

    return {
      servers: {
        used: serverCount,
        limit: limits.servers,
        unlimited: isUnlimited(limits.servers),
      },
      databases: {
        used: databaseCount,
        limit: limits.databases,
        unlimited: isUnlimited(limits.databases),
      },
      projects: {
        used: projectCount,
        limit: limits.projects,
        unlimited: isUnlimited(limits.projects),
      },
      deploymentsThisMonth: {
        used: deploymentCount,
        limit: limits.deploymentsPerMonth,
        unlimited: isUnlimited(limits.deploymentsPerMonth),
      },
      teamMembers: {
        used: memberCount,
        limit: limits.teamMembers,
        unlimited: isUnlimited(limits.teamMembers),
      },
      customDomains: {
        used: domainCount,
        limit: limits.customDomains,
        unlimited: isUnlimited(limits.customDomains),
      },
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
