import { HTTPException } from 'hono/http-exception';
import { eq, and, gte, inArray, desc, sql, count } from 'drizzle-orm';
import { db } from '../db';
import { deployments } from '../db/schema/deployments';
import { projects } from '../db/schema/projects';
import { servers } from '../db/schema/servers';
import { organizationRepository } from '../repositories/organization.repository';
import { billingService, type UsageStats } from './billing.service';
import { infraBillingService } from './infra-billing.service';
import { planLimitsService } from './plan-limits.service';
import { t, type SupportedLocale } from '../i18n';
import { env } from '../config/env';
import { getCachedJson } from '../lib/read-through-cache';

export interface DeploymentCounts {
  running: number;
  inProgress: number;
  failed: number;
  failedLast24h: number;
}

export interface RecentFailedDeployment {
  id: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  errorMessage: string | null;
  createdAt: Date;
}

export type ActionSeverity = 'critical' | 'warning' | 'info';

export interface DashboardActionItem {
  id: string;
  severity: ActionSeverity;
  title: string;
  description: string;
  href: string;
}

export interface UsageWarning {
  key: keyof UsageStats;
  used: number;
  limit: number;
  percent: number;
}

export interface DashboardInfraWalletAlert {
  isLowBalance: boolean;
  balanceCents: number;
  runwayDays: number | null;
}

export interface DashboardOverview {
  deployments: DeploymentCounts;
  recentFailures: RecentFailedDeployment[];
  actionItems: DashboardActionItem[];
  usageWarnings: UsageWarning[];
  infraWallet: DashboardInfraWalletAlert | null;
}

const IN_PROGRESS_STATUSES = ['pending', 'building', 'deploying'] as const;
const USAGE_WARN_THRESHOLD = 80;

function fillTemplate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (s, [k, v]) => s.replaceAll(`{${k}}`, v),
    template
  );
}

class DashboardService {
  async getOverview(
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ): Promise<DashboardOverview> {
    const cacheKey = `cache:dashboard:overview:${organizationId}:${locale}`;
    const ttl = env.DASHBOARD_OVERVIEW_CACHE_TTL_SEC;

    return getCachedJson(cacheKey, ttl, () =>
      this.loadOverview(organizationId, userId, locale),
    );
  }

  private async loadOverview(
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ): Promise<DashboardOverview> {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HTTPException(404, { message: t(locale, 'organizations', 'notFound') });
    }

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const orgProjectFilter = eq(projects.organizationId, organizationId);

    const [runningRow, inProgressRow, failedRow, failed24Row] = await Promise.all([
      db
        .select({ count: count() })
        .from(deployments)
        .innerJoin(projects, eq(deployments.projectId, projects.id))
        .where(and(orgProjectFilter, eq(deployments.status, 'running'))),
      db
        .select({ count: count() })
        .from(deployments)
        .innerJoin(projects, eq(deployments.projectId, projects.id))
        .where(
          and(
            orgProjectFilter,
            inArray(deployments.status, [...IN_PROGRESS_STATUSES])
          )
        ),
      db
        .select({ count: count() })
        .from(deployments)
        .innerJoin(projects, eq(deployments.projectId, projects.id))
        .where(and(orgProjectFilter, eq(deployments.status, 'failed'))),
      db
        .select({ count: count() })
        .from(deployments)
        .innerJoin(projects, eq(deployments.projectId, projects.id))
        .where(
          and(
            orgProjectFilter,
            eq(deployments.status, 'failed'),
            gte(deployments.createdAt, since24h)
          )
        ),
    ]);

    const recentFailureRows = await db
      .select({
        id: deployments.id,
        projectId: projects.id,
        projectName: projects.name,
        projectSlug: projects.slug,
        errorMessage: deployments.errorMessage,
        createdAt: deployments.createdAt,
      })
      .from(deployments)
      .innerJoin(projects, eq(deployments.projectId, projects.id))
      .where(and(orgProjectFilter, eq(deployments.status, 'failed')))
      .orderBy(desc(deployments.createdAt))
      .limit(5);

    const serverIssueRows = await db
      .select({
        id: servers.id,
        name: servers.name,
        status: servers.status,
        setupStatus: servers.setupStatus,
      })
      .from(servers)
      .where(
        and(
          eq(servers.organizationId, organizationId),
          sql`(${servers.setupStatus} = 'failed' OR ${servers.status} = 'error')`
        )
      );

    const effectiveLimits = await planLimitsService.getEffectiveLimits(organizationId);
    const usage = await billingService.getUsageStats(organizationId, effectiveLimits);
    const usageWarnings = this.buildUsageWarnings(usage);
    const wallet = await infraBillingService.getWalletSummary(organizationId);
    const infraWallet: DashboardInfraWalletAlert | null = wallet.isLowBalance
      ? {
          isLowBalance: true,
          balanceCents: wallet.balanceCents,
          runwayDays: wallet.runwayDays,
        }
      : null;

    const actionItems = this.buildActionItems({
      locale,
      failedLast24h: failed24Row[0]?.count ?? 0,
      totalFailed: failedRow[0]?.count ?? 0,
      inProgress: inProgressRow[0]?.count ?? 0,
      serverIssues: serverIssueRows,
      usageWarnings,
      recentFailures: recentFailureRows,
      infraWallet,
    });

    return {
      deployments: {
        running: runningRow[0]?.count ?? 0,
        inProgress: inProgressRow[0]?.count ?? 0,
        failed: failedRow[0]?.count ?? 0,
        failedLast24h: failed24Row[0]?.count ?? 0,
      },
      recentFailures: recentFailureRows.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        projectName: r.projectName,
        projectSlug: r.projectSlug,
        errorMessage: r.errorMessage,
        createdAt: r.createdAt,
      })),
      actionItems,
      usageWarnings,
      infraWallet,
    };
  }

  private buildUsageWarnings(usage: UsageStats): UsageWarning[] {
    const keys = Object.keys(usage) as (keyof UsageStats)[];
    const warnings: UsageWarning[] = [];

    for (const key of keys) {
      const item = usage[key];
      if (item.unlimited || item.limit <= 0) continue;
      const percent = Math.round((item.used / item.limit) * 100);
      if (percent >= USAGE_WARN_THRESHOLD) {
        warnings.push({ key, used: item.used, limit: item.limit, percent });
      }
    }

    return warnings.sort((a, b) => b.percent - a.percent);
  }

  private buildActionItems(input: {
    locale: SupportedLocale;
    failedLast24h: number;
    totalFailed: number;
    inProgress: number;
    serverIssues: { id: string; name: string; status: string; setupStatus: string }[];
    usageWarnings: UsageWarning[];
    recentFailures: { projectId: string; projectName: string }[];
    infraWallet: DashboardInfraWalletAlert | null;
  }): DashboardActionItem[] {
    const items: DashboardActionItem[] = [];
    const { locale } = input;

    if (input.infraWallet?.isLowBalance) {
      const runway =
        input.infraWallet.runwayDays != null && input.infraWallet.runwayDays > 0
          ? fillTemplate(t(locale, 'billing', 'infraRunwayDays'), {
              days: String(input.infraWallet.runwayDays),
            })
          : t(locale, 'billing', 'infraLowBalanceWarning');
      items.push({
        id: 'infra-low-balance',
        severity: 'warning',
        title: t(locale, 'dashboard', 'infraLowBalanceTitle'),
        description: runway,
        href: '/dashboard/billing',
      });
    }

    if (input.failedLast24h > 0) {
      items.push({
        id: 'failed-24h',
        severity: 'critical',
        title: fillTemplate(t(locale, 'dashboard', 'actionFailedDeploymentsTitle'), {
          count: String(input.failedLast24h),
        }),
        description: t(locale, 'dashboard', 'actionFailedDeploymentsDesc'),
        href: '/dashboard/alerts',
      });
    } else if (input.totalFailed > 0) {
      const first = input.recentFailures[0];
      items.push({
        id: 'failed-total',
        severity: 'warning',
        title: fillTemplate(t(locale, 'dashboard', 'actionFailedDeploymentsTitle'), {
          count: String(input.totalFailed),
        }),
        description: first
          ? fillTemplate(t(locale, 'dashboard', 'actionFailedLatestDesc'), {
              project: first.projectName,
            })
          : t(locale, 'dashboard', 'actionFailedDeploymentsDesc'),
        href: first
          ? `/dashboard/projects/${first.projectId}?tab=deployments`
          : '/dashboard/alerts',
      });
    }

    for (const server of input.serverIssues.slice(0, 3)) {
      items.push({
        id: `server-${server.id}`,
        severity: server.setupStatus === 'failed' ? 'critical' : 'warning',
        title: fillTemplate(t(locale, 'dashboard', 'actionServerIssueTitle'), {
          name: server.name,
        }),
        description:
          server.setupStatus === 'failed'
            ? t(locale, 'dashboard', 'actionServerSetupFailedDesc')
            : t(locale, 'dashboard', 'actionServerErrorDesc'),
        href: `/dashboard/servers/${server.id}`,
      });
    }

    const usageResourceLabels: Record<keyof UsageStats, string> = {
      servers: t(locale, 'dashboard', 'usageResourceServers'),
      databases: t(locale, 'dashboard', 'usageResourceDatabases'),
      projects: t(locale, 'dashboard', 'usageResourceProjects'),
      deploymentsThisMonth: t(locale, 'dashboard', 'usageResourceDeployments'),
      teamMembers: t(locale, 'dashboard', 'usageResourceTeamMembers'),
      customDomains: t(locale, 'dashboard', 'usageResourceCustomDomains'),
      buildMinutesThisMonth: t(locale, 'dashboard', 'usageResourceBuildMinutes'),
      storageGb: t(locale, 'dashboard', 'usageResourceStorage'),
      bandwidthGb: t(locale, 'dashboard', 'usageResourceBandwidth'),
    };

    for (const warning of input.usageWarnings.slice(0, 2)) {
      items.push({
        id: `usage-${warning.key}`,
        severity: warning.percent >= 95 ? 'critical' : 'warning',
        title: fillTemplate(t(locale, 'dashboard', 'actionUsageLimitTitle'), {
          percent: String(warning.percent),
        }),
        description: fillTemplate(t(locale, 'dashboard', 'actionUsageLimitDesc'), {
          resource: usageResourceLabels[warning.key],
        }),
        href: '/dashboard/billing',
      });
    }

    if (input.inProgress > 0 && items.length < 6) {
      items.push({
        id: 'in-progress',
        severity: 'info',
        title: fillTemplate(t(locale, 'dashboard', 'actionInProgressTitle'), {
          count: String(input.inProgress),
        }),
        description: t(locale, 'dashboard', 'actionInProgressDesc'),
        href: '/dashboard/projects',
      });
    }

    return items.slice(0, 6);
  }
}

export const dashboardService = new DashboardService();
