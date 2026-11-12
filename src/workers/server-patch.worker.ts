import { randomUUID } from 'crypto';
import { Worker, type Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { addServerPatchJob, QUEUE_NAMES, type ServerPatchJobData } from '../lib/queue';
import { getBullRedisConnection } from '../lib/redis-connection';
import { decrypt } from '../lib/encryption';
import { logger } from '../lib/logger';
import {
  applySecurityPatches,
  describePatchRun,
  PatchApplyError,
  tailOutput,
  type PatchApplyResult,
} from '../lib/server-patch-apply';
import { acquireServerPatchLock, releaseServerPatchLock } from '../lib/server-patch-lock';
import {
  AUTO_PATCH_DEFER_MS,
  autoPatchWindowEnd,
  hasDeployInProgress,
  nextAutoPatchAlert,
  removeServerAutoPatchSchedule,
  toAutoPatchSettings,
  type AutoPatchAlert,
  type ServerAutoPatchLastRun,
} from '../lib/server-auto-patch';
import { activityService } from '../services/activity.service';
import { serverAutoPatchAlertService } from '../services/server-auto-patch-alert.service';
import { SSHClient } from '../utils/ssh';

let serverPatchWorker: Worker<ServerPatchJobData> | null = null;

type ServerPatchJobResult =
  | {
      status: 'skipped';
      reason: 'locked' | 'server_deleted' | 'disabled' | 'outside_window' | 'server_not_ready' | 'deploy_in_progress';
    }
  | { status: 'deferred'; until: string }
  | ({ status: 'applied'; summary: string } & Omit<PatchApplyResult, 'output'>);

/**
 * Keep the outcome of a scheduled run on the server row (health report) and email the organization
 * when it failed or left a reboot pending, once per condition (`nextAutoPatchAlert`). Never throws.
 */
async function recordAutoPatchRun(
  server: { id: string; name: string; organizationId: string },
  lastRun: ServerAutoPatchLastRun
): Promise<void> {
  let alert: AutoPatchAlert | null;
  try {
    const [row] = await db
      .select({ autoPatchNotified: servers.autoPatchNotified })
      .from(servers)
      .where(eq(servers.id, server.id))
      .limit(1);
    const next = nextAutoPatchAlert(row?.autoPatchNotified ?? null, lastRun);
    await db
      .update(servers)
      .set({ lastAutoPatch: lastRun, autoPatchNotified: next.notified })
      .where(eq(servers.id, server.id));
    alert = next.notify;
  } catch (err) {
    logger.warn({ err, serverId: server.id }, 'Could not store the outcome of the scheduled security update run');
    return;
  }

  if (!alert) return;
  await serverAutoPatchAlertService.announce(server, alert, lastRun).catch((err) => {
    logger.error({ err, serverId: server.id, alert }, 'Scheduled security update alert failed to send');
  });
}

/**
 * What a scheduled run (trigger 'auto') checks before it touches the server. Null when it may go
 * ahead. Nothing runs when the setting was turned off (the schedule is removed), outside the
 * maintenance window or on a server that is not running. While a deploy is going on the run is put
 * off; when that lasts the whole window it is recorded as skipped.
 */
async function gateScheduledRun(job: Job<ServerPatchJobData>, now: Date = new Date()): Promise<ServerPatchJobResult | null> {
  const { serverId, organizationId } = job.data;
  const [server] = await db
    .select({
      id: servers.id,
      name: servers.name,
      status: servers.status,
      setupStatus: servers.setupStatus,
      autoPatch: servers.autoPatch,
      autoPatchHour: servers.autoPatchHour,
      autoPatchWeekday: servers.autoPatchWeekday,
    })
    .from(servers)
    .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
    .limit(1);

  const settings = server ? toAutoPatchSettings(server) : null;
  if (!server || !settings || settings.autoPatch === 'off') {
    // Deleted or turned off since the schedule was written: drop the schedule, run nothing
    await removeServerAutoPatchSchedule(serverId).catch((err) => {
      logger.warn({ err, serverId }, 'Could not remove the automatic security update schedule');
    });
    return { status: 'skipped', reason: server ? 'disabled' : 'server_deleted' };
  }

  const windowEnd = autoPatchWindowEnd(now, settings);
  if (!windowEnd) {
    logger.warn({ jobId: job.id, serverId }, 'Scheduled security update run skipped: outside the maintenance window');
    return { status: 'skipped', reason: 'outside_window' };
  }

  if (server.status !== 'running' || server.setupStatus !== 'completed') {
    return { status: 'skipped', reason: 'server_not_ready' };
  }

  if (!(await hasDeployInProgress(serverId))) return null;

  const deferrals = (job.data.deferrals ?? 0) + 1;
  if (now.getTime() + AUTO_PATCH_DEFER_MS < windowEnd.getTime()) {
    const retry = await addServerPatchJob({ ...job.data, deferrals }, { delay: AUTO_PATCH_DEFER_MS });
    if (retry) {
      const until = new Date(now.getTime() + AUTO_PATCH_DEFER_MS).toISOString();
      logger.info({ jobId: job.id, retryJobId: retry.id, serverId, until }, 'Scheduled security update run put off: a deploy is going on');
      return { status: 'deferred', until };
    }
  }

  const error = 'A deploy was going on on the server for the whole maintenance window; nothing was installed';
  await activityService.log({
    organizationId,
    action: 'server.patches_skipped',
    description: `Server "${server.name}": automatic security updates skipped: ${error}`,
    metadata: {
      serverId,
      serverName: server.name,
      requestedBy: null,
      jobId: job.id,
      trigger: 'auto',
      code: 'DEPLOY_IN_PROGRESS',
      error,
      deferrals: deferrals - 1,
    },
  });
  await recordAutoPatchRun({ id: serverId, name: server.name, organizationId }, {
    at: now.toISOString(),
    status: 'skipped',
    packagesApplied: null,
    rebootRequired: null,
    summary: null,
    error,
    code: 'DEPLOY_IN_PROGRESS',
  });
  return { status: 'skipped', reason: 'deploy_in_progress' };
}

/**
 * One security-update run, asked for (POST /servers/:serverId/patches/apply) or scheduled: holds
 * the server's patch lock for the whole run, records the outcome on the audit log (where the server
 * timeline reads it from) and never reboots. A scheduled run also keeps its outcome on the server
 * and emails a failure or a pending reboot, once per condition.
 */
export async function processServerPatchJob(job: Job<ServerPatchJobData>): Promise<ServerPatchJobResult> {
  const { serverId, organizationId, requestedBy } = job.data;
  const trigger = job.data.trigger ?? 'manual';

  if (trigger === 'auto') {
    const gated = await gateScheduledRun(job);
    if (gated) return gated;
  }

  // A scheduled run was not queued with a lock: it takes one here (a manual run in progress wins)
  const lockToken = job.data.lockToken ?? randomUUID();
  if (!(await acquireServerPatchLock(serverId, lockToken))) {
    logger.warn({ jobId: job.id, serverId }, 'Server patch run skipped: another run holds the lock');
    return { status: 'skipped', reason: 'locked' };
  }

  try {
    const [server] = await db
      .select({ id: servers.id, name: servers.name, ipv4: servers.ipv4, sshPrivateKey: servers.sshPrivateKey })
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!server) return { status: 'skipped', reason: 'server_deleted' };

    const metadata = { serverId, serverName: server.name, requestedBy, jobId: job.id, trigger };
    const label = trigger === 'auto' ? `Server "${server.name}" (automatic)` : `Server "${server.name}"`;
    let ssh: SSHClient | null = null;
    try {
      if (!server.ipv4 || !server.sshPrivateKey) {
        throw new PatchApplyError('SSH_UNAVAILABLE', 'Server is not reachable via SSH');
      }
      ssh = new SSHClient();
      await ssh.connect({ host: server.ipv4, port: 22, username: 'root', privateKey: decrypt(server.sshPrivateKey) });

      const result = await applySecurityPatches(ssh);
      const summary = describePatchRun(result);
      await activityService.log({
        organizationId,
        action: 'server.patches_applied',
        description: `${label}: ${summary}`,
        metadata: { ...metadata, summary, ...result },
      });
      if (trigger === 'auto') {
        await recordAutoPatchRun({ id: serverId, name: server.name, organizationId }, {
          at: new Date().toISOString(),
          status: 'applied',
          packagesApplied: result.packageManager === 'apt' ? result.packages.length : null,
          rebootRequired: result.rebootRequired,
          summary,
          error: null,
          code: null,
        });
      }
      logger.info({ jobId: job.id, serverId, trigger, summary }, 'Server security updates applied');

      const { output: _output, ...rest } = result;
      return { status: 'applied', summary, ...rest };
    } catch (err) {
      const code = err instanceof PatchApplyError ? err.code : 'SSH_ERROR';
      const message = err instanceof Error ? err.message : String(err);
      await activityService.log({
        organizationId,
        action: 'server.patches_failed',
        description: `${label}: applying security updates failed: ${message}`,
        metadata: {
          ...metadata,
          code,
          error: message,
          output: err instanceof PatchApplyError ? tailOutput(err.output) : '',
        },
      });
      if (trigger === 'auto') {
        await recordAutoPatchRun({ id: serverId, name: server.name, organizationId }, {
          at: new Date().toISOString(),
          status: 'failed',
          packagesApplied: null,
          rebootRequired: null,
          summary: null,
          error: message,
          code,
        });
      }
      throw err;
    } finally {
      ssh?.disconnect();
    }
  } finally {
    await releaseServerPatchLock(serverId, lockToken);
  }
}

export function startServerPatchWorker(): Worker<ServerPatchJobData> | null {
  const connection = getBullRedisConnection();
  if (!connection) return null;

  if (!serverPatchWorker) {
    serverPatchWorker = new Worker<ServerPatchJobData>(QUEUE_NAMES.SERVER_PATCHES, processServerPatchJob, {
      connection,
      concurrency: 2,
      // A run whose worker died is failed, not replayed: the upgrade may have half happened
      maxStalledCount: 0,
    });
    serverPatchWorker.on('failed', (job, err) => {
      logger.warn({ jobId: job?.id, serverId: job?.data.serverId, err }, 'Server patch job failed');
    });
  }

  return serverPatchWorker;
}

export async function stopServerPatchWorker(): Promise<void> {
  if (serverPatchWorker) {
    await serverPatchWorker.close();
    serverPatchWorker = null;
  }
}
