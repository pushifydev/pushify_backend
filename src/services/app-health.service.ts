import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { deployments } from '../db/schema/deployments';
import { healthChecks, healthCheckLogs, projectHealthState } from '../db/schema/healthchecks';
import { organizationRepository } from '../repositories/organization.repository';
import { deploymentAlertRepository } from '../repositories/deployment-alert.repository';
import { healthCheckService } from './healthcheck.service';
import { notificationService } from './notification.service';
import { restartPushifyContainer } from '../lib/container-resolve';
import { sendAppDownEmail, sendAppRecoveredEmail } from '../lib/email';
import { formatDuration, nextHealthState, type HealthState } from '../lib/app-health';
import { wsManager } from '../lib/ws';
import { logger } from '../lib/logger';

/**
 * Is each deployed app still answering? Every active, awake project with a URL is checked —
 * a `health_checks` row only customises it (endpoint, interval, threshold, auto-restart).
 * Before this, monitoring ran only for projects that had such a row, and the warning went to the
 * project's notification channels, so a crash after a deploy usually reached nobody.
 */

const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_THRESHOLD = 3;
const DEFAULT_TIMEOUT_SECONDS = 10;
const CHECK_CONCURRENCY = 8;

interface Candidate {
  projectId: string;
  slug: string;
  name: string;
  organizationId: string;
  serverId: string | null;
  url: string;
  deploymentId: string | null;
  endpoint: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  threshold: number;
  autoRestart: boolean;
  /** Only a configured check demands a 2xx; otherwise any answer means the app is up. */
  requireOk: boolean;
}

function toState(row: typeof projectHealthState.$inferSelect | undefined): HealthState {
  return {
    status: (row?.status as HealthState['status']) ?? 'unknown',
    failCount: row?.failCount ?? 0,
    downSince: row?.downSince ?? null,
    notifiedAt: row?.notifiedAt ?? null,
  };
}

export const appHealthService = {
  /** Projects worth checking: active, awake, with a live deployment and a URL to call. */
  async candidates(): Promise<Candidate[]> {
    const rows = await db
      .select({
        projectId: projects.id,
        slug: projects.slug,
        name: projects.name,
        organizationId: projects.organizationId,
        serverId: projects.serverId,
        settings: projects.settings,
        config: healthChecks,
      })
      .from(projects)
      .leftJoin(healthChecks, and(eq(healthChecks.projectId, projects.id), eq(healthChecks.isActive, true)))
      .where(and(eq(projects.status, 'active'), eq(projects.sleepState, 'awake')));

    const withUrl = rows.filter((row) => typeof (row.settings as Record<string, unknown>)?.productionUrl === 'string');
    if (withUrl.length === 0) return [];

    // Only what is actually deployed — a project that never deployed is not "down".
    const live = await db
      .select({ projectId: deployments.projectId, id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.status, 'running'),
          inArray(
            deployments.projectId,
            withUrl.map((row) => row.projectId)
          )
        )
      );
    const liveDeployment = new Map(live.map((d) => [d.projectId, d.id]));

    return withUrl
      .filter((row) => liveDeployment.has(row.projectId))
      .map((row) => ({
        projectId: row.projectId,
        slug: row.slug,
        name: row.name,
        organizationId: row.organizationId,
        serverId: row.serverId,
        url: (row.settings as Record<string, string>).productionUrl,
        deploymentId: liveDeployment.get(row.projectId) ?? null,
        endpoint: row.config?.endpoint ?? '/',
        intervalSeconds: row.config?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
        timeoutSeconds: row.config?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        threshold: row.config?.unhealthyThreshold ?? DEFAULT_THRESHOLD,
        autoRestart: row.config?.autoRestart ?? false,
        requireOk: !!row.config,
      }));
  },

  /** One check: call the app, move its state on, tell people when that state changed. */
  async checkProject(candidate: Candidate, now: Date = new Date()): Promise<'up' | 'down' | 'unknown'> {
    const url = `${candidate.url.replace(/\/$/, '')}${candidate.endpoint.startsWith('/') ? candidate.endpoint : `/${candidate.endpoint}`}`;
    const result = await healthCheckService.performHealthCheck(candidate.projectId, url, candidate.timeoutSeconds, {
      // Without a configured endpoint, an answer is an answer: a 404 on / still means it runs.
      healthyWhen: candidate.requireOk ? 'ok' : 'answered',
    });

    const [existing] = await db
      .select()
      .from(projectHealthState)
      .where(eq(projectHealthState.projectId, candidate.projectId));
    const previous = toState(existing);
    const transition = nextHealthState(previous, result, candidate.threshold, now);

    const values = {
      projectId: candidate.projectId,
      url,
      status: transition.state.status,
      statusCode: result.statusCode ?? null,
      responseTimeMs: result.responseTimeMs ?? null,
      failCount: transition.state.failCount,
      error: result.error ?? null,
      downSince: transition.state.downSince,
      notifiedAt: transition.state.notifiedAt,
      lastCheckedAt: now,
      updatedAt: now,
    };
    await db
      .insert(projectHealthState)
      .values(values)
      .onConflictDoUpdate({ target: projectHealthState.projectId, set: values });

    // A row per check only for configured checks (they drive the chart); otherwise just changes.
    if (candidate.requireOk || transition.notify || previous.status !== transition.state.status) {
      await db
        .insert(healthCheckLogs)
        .values({
          projectId: candidate.projectId,
          deploymentId: candidate.deploymentId,
          status: result.healthy ? 'healthy' : result.error === 'Timeout' ? 'timeout' : 'unhealthy',
          responseTimeMs: result.responseTimeMs,
          statusCode: result.statusCode,
          consecutiveFailures: transition.state.failCount,
          actionTaken: transition.notify === 'down' ? 'notified' : 'none',
          errorMessage: result.error,
        })
        .catch(() => {});
    }

    wsManager
      .publish(`project:${candidate.projectId}`, {
        type: 'healthcheck:result',
        data: {
          projectId: candidate.projectId,
          healthy: result.healthy,
          responseTimeMs: result.responseTimeMs,
          consecutiveFailures: transition.state.failCount,
          status: transition.state.status,
        },
      })
      .catch(() => {});

    if (transition.notify === 'down') {
      await this.announce(candidate, 'down', { statusCode: result.statusCode, error: result.error });
      if (candidate.autoRestart && candidate.serverId !== undefined) {
        const restarted = await restartPushifyContainer(candidate.slug, candidate.serverId).catch(() => false);
        logger.info({ projectId: candidate.projectId, restarted }, 'Auto-restart after failed health checks');
      }
    } else if (transition.notify === 'up') {
      await this.announce(candidate, 'up', { downForMs: transition.downForMs ?? 0 });
    }

    return transition.state.status;
  },

  /** Email everyone who keeps deployment alerts on, plus the project's own channels. */
  async announce(
    candidate: Candidate,
    kind: 'down' | 'up',
    details: { statusCode?: number; error?: string; downForMs?: number }
  ): Promise<void> {
    try {
      await notificationService.sendNotifications(
        candidate.projectId,
        kind === 'down' ? 'health.unhealthy' : 'health.recovered',
        {
          status: kind === 'down' ? 'unhealthy' : 'healthy',
          message:
            kind === 'down'
              ? `${candidate.url} is not answering${details.statusCode ? ` (HTTP ${details.statusCode})` : details.error ? ` (${details.error})` : ''}`
              : `${candidate.url} is answering again`,
        }
      );
    } catch (err) {
      logger.warn({ err, projectId: candidate.projectId }, 'Health notification channels failed');
    }

    try {
      const [recipients, org] = await Promise.all([
        deploymentAlertRepository.findAlertRecipients(candidate.organizationId),
        organizationRepository.findById(candidate.organizationId),
      ]);
      for (const recipient of recipients) {
        if (kind === 'down') {
          await sendAppDownEmail(recipient.email, {
            orgName: org?.name ?? '',
            projectName: candidate.name,
            projectId: candidate.projectId,
            url: candidate.url,
            statusCode: details.statusCode,
            error: details.error,
          });
        } else {
          await sendAppRecoveredEmail(recipient.email, {
            orgName: org?.name ?? '',
            projectName: candidate.name,
            projectId: candidate.projectId,
            url: candidate.url,
            downFor: formatDuration(details.downForMs ?? 0),
          });
        }
      }
    } catch (err) {
      logger.error({ err, projectId: candidate.projectId }, 'Health alert emails failed');
    }
  },

  /** Every project whose interval has elapsed, a few at a time. */
  async checkDue(lastChecked: Map<string, number>, now: Date = new Date()): Promise<{ checked: number; down: number }> {
    const due = (await this.candidates()).filter(
      (candidate) => now.getTime() - (lastChecked.get(candidate.projectId) ?? 0) >= candidate.intervalSeconds * 1000
    );

    let down = 0;
    for (let i = 0; i < due.length; i += CHECK_CONCURRENCY) {
      const batch = due.slice(i, i + CHECK_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (candidate) => {
          lastChecked.set(candidate.projectId, now.getTime());
          try {
            return await this.checkProject(candidate, now);
          } catch (err) {
            logger.error({ err, projectId: candidate.projectId }, 'Health check failed to run');
            return 'unknown' as const;
          }
        })
      );
      down += results.filter((status) => status === 'down').length;
    }
    return { checked: due.length, down };
  },
};
