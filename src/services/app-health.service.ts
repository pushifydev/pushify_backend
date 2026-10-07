import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { deployments } from '../db/schema/deployments';
import { servers } from '../db/schema/servers';
import { healthChecks, healthCheckLogs, projectHealthState } from '../db/schema/healthchecks';
import { organizationRepository } from '../repositories/organization.repository';
import { deploymentAlertRepository } from '../repositories/deployment-alert.repository';
import { healthCheckService } from './healthcheck.service';
import { notificationService } from './notification.service';
import { restartPushifyContainer } from '../lib/container-resolve';
import { sendAppDownEmail, sendAppRecoveredEmail } from '../lib/email';
import {
  classifyDownReason,
  formatDuration,
  nextHealthState,
  type DownReason,
  type HealthState,
} from '../lib/app-health';
import { decrypt } from '../lib/encryption';
import { getSSHConnection } from '../utils/ssh';
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
/** SSH probe used only when an alert is about to go out and the app gave no HTTP answer. */
const SSH_PROBE_TIMEOUT_MS = 10_000;

/** One line on what the reason means, for the notification channels. */
export function describeDownReason(reason: DownReason, byos: boolean): string {
  switch (reason) {
    case 'server_unreachable':
      return byos
        ? 'Your server is not reachable (no connection, SSH not answering). Check that the server is powered on, has network access and that its firewall allows ports 22, 80 and 443.'
        : 'The server running this app is not reachable (no connection). Pushify is looking into it; check the server page for its status.';
    case 'deploy_failed':
      return 'The latest deployment failed. Open the deployment logs to see why, then redeploy or roll back.';
    case 'app_error':
    default:
      return 'The app is answering with errors or not at all while its server is up. It may have crashed, run out of memory or be stuck starting — its logs usually say which.';
  }
}

interface ServerInfo {
  byos: boolean;
  ipv4: string | null;
  sshPrivateKey: string | null;
}

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
    reminderStep: row?.reminderStep ?? 0,
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

    // Why it is down — worked out only when someone is about to be told, since it may SSH.
    let downReason: DownReason | null = transition.state.status === 'down' ? ((existing?.downReason as DownReason | null) ?? null) : null;
    let server: ServerInfo | null = null;
    if (transition.notify === 'down' || transition.notify === 'reminder') {
      server = await this.serverInfo(candidate.serverId);
      downReason = await this.diagnose(candidate, result, server);
    }

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
      downReason,
      reminderStep: transition.state.reminderStep ?? 0,
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
          downReason,
        },
      })
      .catch(() => {});

    if (transition.notify === 'down' || transition.notify === 'reminder') {
      await this.announce(candidate, transition.notify, {
        statusCode: result.statusCode,
        error: result.error,
        reason: downReason ?? 'app_error',
        byos: server?.byos ?? false,
        downForMs: transition.downForMs ?? undefined,
      });
    }
    if (transition.notify === 'down') {
      // Restarting a container on a server we cannot reach is pointless.
      if (candidate.autoRestart && candidate.serverId !== undefined && downReason !== 'server_unreachable') {
        const restarted = await restartPushifyContainer(candidate.slug, candidate.serverId).catch(() => false);
        logger.info({ projectId: candidate.projectId, restarted }, 'Auto-restart after failed health checks');
      }
    } else if (transition.notify === 'up') {
      await this.announce(candidate, 'up', { downForMs: transition.downForMs ?? 0 });
    }

    return transition.state.status;
  },

  /** The project's server: is it the customer's own (BYOS), and how to SSH into it. */
  async serverInfo(serverId: string | null): Promise<ServerInfo | null> {
    if (!serverId) return null;
    const [row] = await db
      .select({ provider: servers.provider, isManaged: servers.isManaged, ipv4: servers.ipv4, sshPrivateKey: servers.sshPrivateKey })
      .from(servers)
      .where(eq(servers.id, serverId));
    if (!row) return null;
    return { byos: row.provider === 'self_hosted' || !row.isManaged, ipv4: row.ipv4, sshPrivateKey: row.sshPrivateKey };
  },

  /** Can we still log into the server? undefined when we have no way to try. */
  async probeServer(server: ServerInfo | null): Promise<boolean | undefined> {
    if (!server?.ipv4 || !server.sshPrivateKey) return undefined;
    const probe = (async () => {
      const ssh = await getSSHConnection({ host: server.ipv4!, port: 22, username: 'root', privateKey: decrypt(server.sshPrivateKey!) });
      const res = await ssh.exec('true');
      return res.code === 0;
    })();
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SSH_PROBE_TIMEOUT_MS).unref?.());
    return Promise.race([probe, timeout]).catch(() => false);
  },

  /** server_unreachable / app_error / deploy_failed for the alert and the API. */
  async diagnose(
    candidate: Candidate,
    result: { statusCode?: number; error?: string },
    server: ServerInfo | null
  ): Promise<DownReason> {
    try {
      const [latest] = await db
        .select({ status: deployments.status })
        .from(deployments)
        .where(eq(deployments.projectId, candidate.projectId))
        .orderBy(desc(deployments.createdAt))
        .limit(1);
      const hasAnswer = !!result.statusCode && result.statusCode > 0;
      return classifyDownReason({
        statusCode: result.statusCode,
        error: result.error,
        latestDeployFailed: latest?.status === 'failed',
        serverReachable: hasAnswer ? undefined : await this.probeServer(server),
      });
    } catch (err) {
      logger.warn({ err, projectId: candidate.projectId }, 'Could not work out why the app is down');
      return classifyDownReason({ statusCode: result.statusCode, error: result.error });
    }
  },

  /** Email everyone who keeps deployment alerts on, plus the project's own channels. */
  async announce(
    candidate: Candidate,
    kind: 'down' | 'reminder' | 'up',
    details: { statusCode?: number; error?: string; downForMs?: number; reason?: DownReason; byos?: boolean }
  ): Promise<void> {
    const isDown = kind !== 'up';
    const reason = details.reason ?? 'app_error';
    const answer = details.statusCode ? ` (HTTP ${details.statusCode})` : details.error ? ` (${details.error})` : '';
    try {
      await notificationService.sendNotifications(
        candidate.projectId,
        isDown ? 'health.unhealthy' : 'health.recovered',
        {
          status: isDown ? 'unhealthy' : 'healthy',
          message: isDown
            ? `${kind === 'reminder' ? `Still down after ${formatDuration(details.downForMs ?? 0)}: ` : ''}${candidate.url} is not answering${answer} — ${reason}. ${describeDownReason(reason, details.byos ?? false)}`
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
        if (isDown) {
          await sendAppDownEmail(recipient.email, {
            orgName: org?.name ?? '',
            projectName: candidate.name,
            projectId: candidate.projectId,
            url: candidate.url,
            statusCode: details.statusCode,
            error: details.error,
            reason,
            byos: details.byos ?? false,
            downFor: kind === 'reminder' ? formatDuration(details.downForMs ?? 0) : undefined,
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
