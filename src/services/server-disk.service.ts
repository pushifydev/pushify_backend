import { randomUUID } from 'crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { getSSHConnection } from '../utils/ssh';
import { decrypt } from '../lib/encryption';
import { checkServerDiskSpace, diskAlertPercentFor, nextDiskAlertState } from '../lib/server-disk-check';
import { buildDiskBreakdown, runServerDiskCleanup, type ServerDiskBreakdown } from '../lib/server-disk-cleanup';
import { acquireServerDiskCleanupLock, releaseServerDiskCleanupLock } from '../lib/server-disk-cleanup-lock';
import { env } from '../config/env';
import { organizationRepository } from '../repositories/organization.repository';
import { deploymentAlertRepository } from '../repositories/deployment-alert.repository';
import { sendServerDiskEmail } from '../lib/email';
import { adminNotify } from './admin-notify.service';
import { logger } from '../lib/logger';

/**
 * Watching the disk between deploys.
 *
 * `checkServerDiskSpace` existed, but it only ran as part of a deploy. A server that fills up
 * while nothing is being deployed — image layers, logs, a database growing, a runaway volume —
 * was discovered when the *next* deploy failed. By then every container on that host has been
 * starved for as long as it took someone to deploy again, and on a box running managed databases
 * that is data loss territory, not an inconvenience.
 *
 * So: an hourly check of every reachable server, and one email when it crosses the server's
 * alert threshold (`diskAlertPercent`, default 85 — before deploys stop at 90). No reminders while
 * it stays full; the next one comes only after it has dropped 5 points under the line and crossed
 * it again (lib/server-disk-check.ts nextDiskAlertState).
 */

/** Above this, a managed server gets the scheduled Docker cleanup before it is judged. */
const CLEANUP_PERCENT = env.SERVER_DISK_CLEANUP_PERCENT;

export const serverDiskService = {
  /** Check every running server with SSH credentials. Never throws — one bad host is not the run. */
  async checkAll(now: Date = new Date()): Promise<{ checked: number; warned: number; cleaned: number }> {
    const rows = await db
      .select()
      .from(servers)
      .where(and(eq(servers.status, 'running'), isNotNull(servers.sshPrivateKey)));

    let checked = 0;
    let warned = 0;
    let cleaned = 0;

    for (const server of rows) {
      if (!server.ipv4 || !server.sshPrivateKey) continue;
      try {
        const ssh = await getSSHConnection({
          host: server.ipv4,
          username: 'root',
          privateKey: decrypt(server.sshPrivateKey),
        });
        let result = await checkServerDiskSpace(ssh);
        checked++;

        // Managed servers are ours to keep tidy: trim oversized container logs, dangling images
        // and old build cache (never volumes — those are customer data), then judge the disk
        // on what is left.
        let dataBytes: number | undefined;
        let breakdown: ServerDiskBreakdown | undefined;
        // A deploy may be cleaning this server right now (deploy-disk-cleanup.ts): skip, the next
        // hourly run will judge it.
        const lockToken = randomUUID();
        if (
          server.isManaged &&
          result.measured &&
          result.usedPercent >= CLEANUP_PERCENT &&
          (await acquireServerDiskCleanupLock(server.id, lockToken))
        ) {
          const usedPercentBefore = result.usedPercent;
          const cleanup = await runServerDiskCleanup(ssh).finally(() =>
            releaseServerDiskCleanupLock(server.id, lockToken)
          );
          cleaned++;
          if (cleanup.ran) {
            result = await checkServerDiskSpace(ssh);
            dataBytes = cleanup.volumesBytes;
            breakdown = buildDiskBreakdown(cleanup, now);
          }
          logger.info(
            {
              serverId: server.id,
              ran: cleanup.ran,
              usedPercentBefore,
              // Re-measured only when the cleanup ran; otherwise nothing changed on the disk
              usedPercentAfter: cleanup.ran && result.measured ? result.usedPercent : null,
              freedBytes: cleanup.freedBytes,
              logsTruncatedBytes: cleanup.logsTruncatedBytes,
              volumesBytes: cleanup.volumesBytes,
              imagesBytes: cleanup.imagesBytes,
              buildCacheBytes: cleanup.buildCacheBytes,
              logsBytes: cleanup.logsBytes,
              uncappedLogContainers: cleanup.uncappedLogContainers,
              rotatedLogContainers: cleanup.rotatedLogContainers,
              daemonConfig: cleanup.daemonConfig,
            },
            'Server disk cleanup finished'
          );
        }

        const values: Partial<typeof servers.$inferInsert> = {
          diskUsedPercent: result.usedPercent,
          diskCheckedAt: now,
        };
        if (breakdown) values.diskBreakdown = breakdown;

        const alert = nextDiskAlertState(server.diskNotifiedAt, result, diskAlertPercentFor(server), now);
        if (alert.notifiedAt !== server.diskNotifiedAt) values.diskNotifiedAt = alert.notifiedAt;
        if (alert.notify) {
          warned++;
          await this.announce(server, { ...result, dataBytes }, now).catch((err) =>
            logger.error({ err, serverId: server.id }, 'Server disk alert failed to send')
          );
        }

        await db.update(servers).set(values).where(eq(servers.id, server.id));
      } catch (err) {
        // Unreachable is the server monitor's problem, not the disk check's
        logger.debug({ err, serverId: server.id }, 'Could not check disk on server');
      }
    }

    return { checked, warned, cleaned };
  },

  async announce(
    server: typeof servers.$inferSelect,
    result: { usedPercent: number; availGb: number; critical: boolean; dataBytes?: number },
    _now: Date
  ): Promise<void> {
    const [recipients, org] = await Promise.all([
      deploymentAlertRepository.findAlertRecipients(server.organizationId),
      organizationRepository.findById(server.organizationId),
    ]);

    for (const recipient of recipients) {
      await sendServerDiskEmail(recipient.email, {
        orgName: org?.name ?? '',
        serverName: server.name,
        serverId: server.id,
        usedPercent: result.usedPercent,
        availGb: result.availGb,
        critical: result.critical,
        dataGb: result.dataBytes !== undefined ? Math.round((result.dataBytes / 1e9) * 10) / 10 : undefined,
        deployBlockPercent: env.SERVER_DISK_DEPLOY_BLOCK_PERCENT,
        deployMinFreeGb: env.SERVER_DISK_DEPLOY_MIN_FREE_GB,
      }).catch(() => {});
    }

    adminNotify('server.disk_full', {
      server: server.name,
      serverId: server.id,
      usedPercent: result.usedPercent,
      availGb: result.availGb,
      alertPercent: diskAlertPercentFor(server),
      deployBlockPercent: env.SERVER_DISK_DEPLOY_BLOCK_PERCENT,
      critical: result.critical ? 'yes' : 'no',
    });

    logger.warn(
      { serverId: server.id, usedPercent: result.usedPercent, critical: result.critical },
      'Server disk alert sent'
    );
  },
};
