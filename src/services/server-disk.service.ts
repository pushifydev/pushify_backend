import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { getSSHConnection } from '../utils/ssh';
import { decrypt } from '../lib/encryption';
import { checkServerDiskSpace } from '../lib/server-disk-check';
import { buildDiskBreakdown, runServerDiskCleanup, type ServerDiskBreakdown } from '../lib/server-disk-cleanup';
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
 * So: an hourly check of every reachable server, and one email when it crosses the line.
 */

/** Above this, a managed server gets the scheduled Docker cleanup before it is judged. */
const CLEANUP_PERCENT = env.SERVER_DISK_CLEANUP_PERCENT;

/** One mail per day while it stays full: enough to keep it in mind, not enough to be ignored. */
const RENOTIFY_AFTER_MS = 24 * 60 * 60 * 1000;

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
        if (server.isManaged && result.measured && result.usedPercent >= CLEANUP_PERCENT) {
          const usedPercentBefore = result.usedPercent;
          const cleanup = await runServerDiskCleanup(ssh);
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
              usedPercentAfter: result.usedPercent,
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

        if (result.warn) {
          const due =
            !server.diskNotifiedAt || now.getTime() - server.diskNotifiedAt.getTime() >= RENOTIFY_AFTER_MS;
          if (due) {
            values.diskNotifiedAt = now;
            warned++;
            await this.announce(server, { ...result, dataBytes }, now).catch((err) =>
              logger.error({ err, serverId: server.id }, 'Server disk alert failed to send')
            );
          }
        } else if (server.diskNotifiedAt) {
          // Back under the line: forget, so the next time it fills up is a fresh warning
          values.diskNotifiedAt = null;
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
      }).catch(() => {});
    }

    adminNotify('server.disk_full', {
      server: server.name,
      serverId: server.id,
      usedPercent: result.usedPercent,
      availGb: result.availGb,
      critical: result.critical ? 'yes' : 'no',
    });

    logger.warn(
      { serverId: server.id, usedPercent: result.usedPercent, critical: result.critical },
      'Server disk alert sent'
    );
  },
};
