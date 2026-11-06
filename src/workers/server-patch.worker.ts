import { Worker, type Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { QUEUE_NAMES, type ServerPatchJobData } from '../lib/queue';
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
import { activityService } from '../services/activity.service';
import { SSHClient } from '../utils/ssh';

let serverPatchWorker: Worker<ServerPatchJobData> | null = null;

type ServerPatchJobResult =
  | { status: 'skipped'; reason: 'locked' | 'server_deleted' }
  | ({ status: 'applied'; summary: string } & Omit<PatchApplyResult, 'output'>);

/**
 * One security-update run: holds the server's patch lock for the whole run, records the outcome
 * on the audit log (where the server timeline reads it from) and never reboots.
 */
export async function processServerPatchJob(job: Job<ServerPatchJobData>): Promise<ServerPatchJobResult> {
  const { serverId, organizationId, requestedBy, lockToken } = job.data;

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

    const metadata = { serverId, serverName: server.name, requestedBy, jobId: job.id };
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
        description: `Server "${server.name}": ${summary}`,
        metadata: { ...metadata, summary, ...result },
      });
      logger.info({ jobId: job.id, serverId, summary }, 'Server security updates applied');

      const { output: _output, ...rest } = result;
      return { status: 'applied', summary, ...rest };
    } catch (err) {
      const code = err instanceof PatchApplyError ? err.code : 'SSH_ERROR';
      const message = err instanceof Error ? err.message : String(err);
      await activityService.log({
        organizationId,
        action: 'server.patches_failed',
        description: `Server "${server.name}": applying security updates failed: ${message}`,
        metadata: {
          ...metadata,
          code,
          error: message,
          output: err instanceof PatchApplyError ? tailOutput(err.output) : '',
        },
      });
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
