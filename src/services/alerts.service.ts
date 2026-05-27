import { HTTPException } from 'hono/http-exception';
import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { healthChecks } from '../db/schema/healthchecks';
import { organizationRepository } from '../repositories/organization.repository';
import { notificationRepository } from '../repositories/notification.repository';
import { healthCheckRepository } from '../repositories/healthcheck.repository';
import { t, type SupportedLocale } from '../i18n';

export interface AlertsSummary {
  totalChannels: number;
  activeChannels: number;
  projectsWithChannels: number;
  failedDeliveries24h: number;
  healthChecksEnabled: number;
  unhealthyProjects: number;
}

export interface OrgNotificationChannel {
  id: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  type: string;
  name: string;
  events: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrgNotificationLog {
  id: string;
  channelId: string;
  channelName: string;
  channelType: string;
  projectId: string;
  projectName: string;
  eventType: string;
  status: string;
  errorMessage: string | null;
  sentAt: Date;
}

export interface OrgHealthCheckRow {
  projectId: string;
  projectName: string;
  projectSlug: string;
  isActive: boolean;
  endpoint: string;
  intervalSeconds: number;
  autoRestart: boolean;
  lastStatus: string | null;
  consecutiveFailures: number;
  lastCheckedAt: Date | null;
  responseTimeMs: number | null;
}

export interface AlertsOverview {
  summary: AlertsSummary;
  channels: OrgNotificationChannel[];
  recentLogs: OrgNotificationLog[];
  healthChecks: OrgHealthCheckRow[];
}

class AlertsService {
  async getOverview(
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ): Promise<AlertsOverview> {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [channels, recentLogs, failedDeliveries24h, orgProjects, hcConfigs] =
      await Promise.all([
        notificationRepository.findChannelsByOrganization(organizationId),
        notificationRepository.findRecentLogsByOrganization(organizationId, 25),
        notificationRepository.countFailedLogsSince(organizationId, since24h),
        db
          .select({ id: projects.id, name: projects.name, slug: projects.slug })
          .from(projects)
          .where(
            and(
              eq(projects.organizationId, organizationId),
              eq(projects.status, 'active')
            )
          ),
        db
          .select({
            projectId: healthChecks.projectId,
            projectName: projects.name,
            projectSlug: projects.slug,
            isActive: healthChecks.isActive,
            endpoint: healthChecks.endpoint,
            intervalSeconds: healthChecks.intervalSeconds,
            autoRestart: healthChecks.autoRestart,
          })
          .from(healthChecks)
          .innerJoin(projects, eq(healthChecks.projectId, projects.id))
          .where(eq(projects.organizationId, organizationId)),
      ]);

    const projectIdsWithChannels = new Set(channels.map((c) => c.projectId));
    const activeChannels = channels.filter((c) => c.isActive).length;

    let unhealthyProjects = 0;
    const healthChecksConfigured: OrgHealthCheckRow[] = await Promise.all(
      hcConfigs.map(async (hc) => {
        const latest = await healthCheckRepository.findLatestLog(hc.projectId);
        const lastStatus = latest?.status ?? null;
        if (
          hc.isActive &&
          lastStatus &&
          (lastStatus === 'unhealthy' || lastStatus === 'timeout')
        ) {
          unhealthyProjects += 1;
        }
        return {
          projectId: hc.projectId,
          projectName: hc.projectName,
          projectSlug: hc.projectSlug,
          isActive: hc.isActive,
          endpoint: hc.endpoint,
          intervalSeconds: hc.intervalSeconds,
          autoRestart: hc.autoRestart,
          lastStatus,
          consecutiveFailures: latest?.consecutiveFailures ?? 0,
          lastCheckedAt: latest?.checkedAt ?? null,
          responseTimeMs: latest?.responseTimeMs ?? null,
        };
      })
    );

    const projectsWithoutHc = orgProjects
      .filter((p) => !hcConfigs.some((hc) => hc.projectId === p.id))
      .map((p) => ({
        projectId: p.id,
        projectName: p.name,
        projectSlug: p.slug,
        isActive: false,
        endpoint: '/health',
        intervalSeconds: 30,
        autoRestart: true,
        lastStatus: null as string | null,
        consecutiveFailures: 0,
        lastCheckedAt: null as Date | null,
        responseTimeMs: null as number | null,
      }));

    return {
      summary: {
        totalChannels: channels.length,
        activeChannels,
        projectsWithChannels: projectIdsWithChannels.size,
        failedDeliveries24h,
        healthChecksEnabled: hcConfigs.filter((h) => h.isActive).length,
        unhealthyProjects,
      },
      channels: channels.map((c) => ({
        id: c.id,
        projectId: c.projectId,
        projectName: c.projectName,
        projectSlug: c.projectSlug,
        type: c.type,
        name: c.name,
        events: c.events,
        isActive: c.isActive,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
      recentLogs: recentLogs.map((l) => ({
        id: l.id,
        channelId: l.channelId,
        channelName: l.channelName,
        channelType: l.channelType,
        projectId: l.projectId,
        projectName: l.projectName,
        eventType: l.eventType,
        status: l.status,
        errorMessage: l.errorMessage,
        sentAt: l.sentAt,
      })),
      healthChecks: [...healthChecksConfigured, ...projectsWithoutHc],
    };
  }
}

export const alertsService = new AlertsService();
