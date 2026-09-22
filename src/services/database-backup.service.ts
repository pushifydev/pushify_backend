import { HTTPException } from 'hono/http-exception';
import { databaseRepository } from '../repositories/database.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { t, type SupportedLocale } from '../i18n';
import { decrypt } from '../lib/encryption';
import { SSHClient } from '../utils/ssh';
import { wsManager } from '../lib/ws';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { db } from '../db';
import { eq } from 'drizzle-orm';
import { servers } from '../db/schema/servers';
import type { DatabaseType } from '../db/schema/databases';
import {
  buildVerifyScript,
  wrapForSsh,
  parseVerifyOutput,
  verifyUnitFor,
  MAX_VERIFY_SIZE_MB,
  VERIFY_EVERY_MS,
  type BackupVerification,
} from '../lib/backup-verify';
import { sendBackupVerificationFailedEmail } from '../lib/email';
import { resolveBillingNotifyEmail } from '../lib/billing-notify';
import { adminNotify } from './admin-notify.service';
import { buildDumpCommand, buildRestoreCommand } from '../lib/database-backup-commands';

// ============ Helpers ============

/**
 * A finished backup. Restores used to leave the row at 'restored', which hid the restore and
 * download buttons and took it out of verification for good — those rows count as finished.
 */
function isFinishedBackup(status: string): boolean {
  return status === 'completed' || status === 'restored';
}

function backupFileName(databaseName: string, type: DatabaseType): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = type === 'redis' ? 'rdb' : 'sql.gz';
  return `${databaseName}_${timestamp}.${ext}`;
}

function backupDir(databaseName: string): string {
  return `/opt/pushify/databases/${databaseName}/backups`;
}

// ============ Service ============

/**
 * What a customer sees of a backup. `offsitePath` is the operator's storage layout, so it is
 * reported as a yes/no rather than handed out; `restored` is an internal step of a restore and
 * reads as `completed` once it is over.
 */
function toPublicBackup<T extends { status: string; offsitePath?: string | null; offsiteStatus?: string | null }>(
  backup: T
): Omit<T, 'offsitePath'> & { offsiteCopy: boolean } {
  const { offsitePath, ...rest } = backup;
  return {
    ...(rest as Omit<T, 'offsitePath'>),
    status: backup.status === 'restored' ? 'completed' : backup.status,
    offsiteCopy: !!offsitePath,
  };
}

export const databaseBackupService = {
  // List backups for a database
  async listBackups(
    databaseId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    const backups = await databaseRepository.findBackupsByDatabase(databaseId);
    return backups.map(toPublicBackup);
  },

  // Get single backup
  async getBackup(
    databaseId: string,
    backupId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    const backup = await databaseRepository.findBackupById(backupId);
    if (!backup || backup.databaseId !== databaseId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'backupNotFound') });
    }

    return backup;
  },

  // Create a manual backup
  async createBackup(
    databaseId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    if (database.status !== 'running') {
      throw new HTTPException(400, { message: t(locale, 'databases', 'databaseMustBeRunning') });
    }

    // Check for in-progress backup
    const existingBackups = await databaseRepository.findBackupsByDatabase(databaseId, 1);
    if (existingBackups.length > 0 && existingBackups[0].status === 'creating') {
      throw new HTTPException(400, { message: t(locale, 'databases', 'backupInProgress') });
    }

    // Start backup asynchronously
    const backup = await this.performBackup(databaseId, 'manual');

    return backup;
  },

  // Internal: perform a backup (used by both manual and automatic)
  async performBackup(databaseId: string, type: 'manual' | 'automatic') {
    const database = await databaseRepository.findById(databaseId);
    if (!database || !database.serverId || !database.containerName) {
      throw new Error(`Database ${databaseId} not found or missing container info`);
    }

    const server = await db.query.servers.findFirst({
      where: eq(servers.id, database.serverId),
    });

    if (!server?.ipv4 || !server.sshPrivateKey) {
      throw new Error(`Server for database ${databaseId} not configured for SSH`);
    }

    const fileName = backupFileName(database.databaseName, database.type as DatabaseType);
    const bkDir = backupDir(database.databaseName);
    const filePath = `${bkDir}/${fileName}`;
    const retentionDays = database.backupRetentionDays || 7;

    // Create backup record
    const backup = await databaseRepository.createBackup({
      databaseId,
      name: fileName,
      type,
      status: 'creating',
      filePath,
      expiresAt: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000),
    });

    // Publish creating status
    wsManager.publish(`database:${databaseId}`, {
      type: 'backup:status',
      data: {
        databaseId,
        backupId: backup.id,
        status: 'creating',
      },
    }).catch(() => {});

    // Perform backup asynchronously
    this.executeBackup(
      backup.id,
      databaseId,
      server,
      database.containerName,
      database.type as DatabaseType,
      database.username,
      decrypt(database.password),
      database.databaseName,
      fileName,
      bkDir,
      filePath,
      { organizationId: database.organizationId, retentionDays }
    ).catch((error) => {
      logger.error({ error, databaseId, backupId: backup.id }, 'Backup execution failed');
    });

    return backup;
  },

  // Internal: execute the actual backup via SSH
  async executeBackup(
    backupId: string,
    databaseId: string,
    server: { ipv4: string | null; sshPrivateKey: string | null },
    containerName: string,
    type: DatabaseType,
    username: string,
    password: string,
    databaseName: string,
    fileName: string,
    bkDir: string,
    filePath: string,
    offsite: { organizationId: string; retentionDays: number }
  ) {
    const ssh = new SSHClient();
    try {
      await ssh.connect({
        host: server.ipv4!,
        username: 'root',
        privateKey: decrypt(server.sshPrivateKey!),
      });

      // Create backup directory
      await ssh.exec(`mkdir -p ${bkDir}`);

      // Run dump command
      const dumpCmd = buildDumpCommand(containerName, type, username, password, databaseName, fileName, bkDir);
      const result = await ssh.exec(dumpCmd);

      if (result.code !== 0) {
        throw new Error(result.stderr || 'Backup command failed');
      }

      // Get file size
      const sizeResult = await ssh.exec(`stat -c %s ${filePath} 2>/dev/null || stat -f %z ${filePath}`);
      const sizeBytes = parseInt(sizeResult.stdout.trim(), 10);
      const sizeMb = Math.round(sizeBytes / (1024 * 1024) * 100) / 100;

      // Copy it off this server. A dump next to the data survives a dropped table and nothing
      // else; the copy that matters is the one somewhere else. Never fails the backup — a
      // backup on the server is still a backup, and the outcome is recorded either way.
      const { offsiteBackupService } = await import('./offsite-backup.service');
      const copy = await offsiteBackupService.upload(ssh, filePath, {
        organizationId: offsite.organizationId,
        databaseId,
        fileName,
      });

      // Update backup record
      await databaseRepository.updateBackup(backupId, {
        status: 'completed',
        sizeMb: Math.max(1, Math.round(sizeMb)),
        completedAt: new Date(),
        offsitePath: copy.path ?? null,
        offsiteStatus: copy.status,
      });

      if (copy.status === 'uploaded') {
        // Retention for the off-site copies runs here, where the remote is reachable
        offsiteBackupService
          .prune(offsite.organizationId, databaseId, env.DB_BACKUP_REMOTE_KEEP_DAYS)
          .catch(() => undefined);
      }

      // Update last backup time on database
      await databaseRepository.update(databaseId, {
        lastBackupAt: new Date(),
      });

      // Publish completed status
      wsManager.publish(`database:${databaseId}`, {
        type: 'backup:status',
        data: {
          databaseId,
          backupId,
          status: 'completed',
          sizeMb: Math.max(1, Math.round(sizeMb)),
        },
      }).catch(() => {});

      logger.info({ databaseId, backupId, sizeMb }, 'Backup completed successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      await databaseRepository.updateBackup(backupId, {
        status: 'failed',
        errorMessage,
        completedAt: new Date(),
      });

      // Publish failed status
      wsManager.publish(`database:${databaseId}`, {
        type: 'backup:status',
        data: {
          databaseId,
          backupId,
          status: 'failed',
          errorMessage,
        },
      }).catch(() => {});

      logger.error({ error, databaseId, backupId }, 'Backup failed');
    } finally {
      ssh.disconnect();
    }
  },

  // Restore database from backup
  async restoreBackup(
    databaseId: string,
    backupId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    if (database.status !== 'running') {
      throw new HTTPException(400, { message: t(locale, 'databases', 'databaseMustBeRunning') });
    }

    const backup = await databaseRepository.findBackupById(backupId);
    if (!backup || backup.databaseId !== databaseId || !isFinishedBackup(backup.status)) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'backupNotFound') });
    }

    if (!database.serverId || !database.containerName || !backup.filePath) {
      throw new HTTPException(400, { message: t(locale, 'databases', 'backupRestoreFailed') });
    }

    const server = await db.query.servers.findFirst({
      where: eq(servers.id, database.serverId),
    });

    if (!server?.ipv4 || !server.sshPrivateKey) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'notProvisioned') });
    }

    // Update backup status to restoring
    await databaseRepository.updateBackup(backupId, { status: 'restoring' as string });

    // Publish restoring status
    wsManager.publish(`database:${databaseId}`, {
      type: 'backup:status',
      data: {
        databaseId,
        backupId,
        status: 'restoring',
      },
    }).catch(() => {});

    // Execute restore asynchronously
    this.executeRestore(
      backupId,
      databaseId,
      server,
      database.containerName,
      database.type as DatabaseType,
      database.username,
      decrypt(database.password),
      database.databaseName,
      backup.filePath,
      backup.offsitePath
    ).catch((error) => {
      logger.error({ error, databaseId, backupId }, 'Restore execution failed');
    });

    return { message: t(locale, 'databases', 'backupRestored') };
  },

  // Internal: execute restore via SSH
  async executeRestore(
    backupId: string,
    databaseId: string,
    server: { ipv4: string | null; sshPrivateKey: string | null },
    containerName: string,
    type: DatabaseType,
    username: string,
    password: string,
    databaseName: string,
    filePath: string,
    offsitePath?: string | null
  ) {
    const ssh = new SSHClient();
    try {
      await ssh.connect({
        host: server.ipv4!,
        username: 'root',
        privateKey: decrypt(server.sshPrivateKey!),
      });

      // The dump may not be on this server: the database was moved, the server was rebuilt, or
      // the disk is what was lost — the case the off-site copy exists for. Fetch it back first.
      if (!(await ssh.fileExists(filePath))) {
        if (!offsitePath) {
          throw new Error(
            'The backup file is not on the server and there is no off-site copy of it. ' +
              'Set DB_BACKUP_RCLONE_REMOTE so future backups are kept elsewhere too.'
          );
        }
        const { offsiteBackupService } = await import('./offsite-backup.service');
        await ssh.exec(`mkdir -p ${filePath.replace(/\/[^/]+$/, '')}`);
        const fetched = await offsiteBackupService.download(ssh, offsitePath, filePath);
        if (!fetched) throw new Error('The off-site copy of this backup could not be read back');
        logger.info({ backupId, offsitePath }, 'Restored the backup file from off-site storage');
      }

      const restoreCmd = buildRestoreCommand(containerName, type, username, password, databaseName, filePath);
      const result = await ssh.exec(restoreCmd);

      if (result.code !== 0) {
        throw new Error(result.stderr || 'Restore command failed');
      }

      // Back to 'completed' so the same backup can be restored or downloaded again.
      await databaseRepository.updateBackup(backupId, { status: 'completed', errorMessage: null });

      wsManager.publish(`database:${databaseId}`, {
        type: 'backup:status',
        data: {
          databaseId,
          backupId,
          status: 'restored',
        },
      }).catch(() => {});

      logger.info({ databaseId, backupId }, 'Restore completed successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      await databaseRepository.updateBackup(backupId, {
        status: 'completed', // Revert to completed on failure
        errorMessage: `Restore failed: ${errorMessage}`,
      });

      wsManager.publish(`database:${databaseId}`, {
        type: 'backup:status',
        data: {
          databaseId,
          backupId,
          status: 'failed',
          errorMessage: `Restore failed: ${errorMessage}`,
        },
      }).catch(() => {});

      logger.error({ error, databaseId, backupId }, 'Restore failed');
    } finally {
      ssh.disconnect();
    }
  },

  // Delete a backup
  async deleteBackup(
    databaseId: string,
    backupId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    const backup = await databaseRepository.findBackupById(backupId);
    if (!backup || backup.databaseId !== databaseId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'backupNotFound') });
    }

    // Delete file from server if exists
    if (backup.filePath && database.serverId) {
      const server = await db.query.servers.findFirst({
        where: eq(servers.id, database.serverId),
      });

      if (server?.ipv4 && server.sshPrivateKey) {
        const ssh = new SSHClient();
        try {
          await ssh.connect({
            host: server.ipv4,
            username: 'root',
            privateKey: decrypt(server.sshPrivateKey),
          });
          await ssh.exec(`rm -f ${backup.filePath}`);
        } catch (error) {
          logger.warn({ error, backupId }, 'Failed to delete backup file from server');
        } finally {
          ssh.disconnect();
        }
      }
    }

    await databaseRepository.deleteBackup(backupId);
  },

  // Download backup file
  async downloadBackup(
    databaseId: string,
    backupId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    const backup = await databaseRepository.findBackupById(backupId);
    if (!backup || backup.databaseId !== databaseId || !isFinishedBackup(backup.status)) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'backupNotFound') });
    }

    if (!backup.filePath || !database.serverId) {
      throw new HTTPException(400, { message: t(locale, 'databases', 'backupNotFound') });
    }

    const server = await db.query.servers.findFirst({
      where: eq(servers.id, database.serverId),
    });

    if (!server?.ipv4 || !server.sshPrivateKey) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'notProvisioned') });
    }

    const ssh = new SSHClient();
    try {
      await ssh.connect({
        host: server.ipv4,
        username: 'root',
        privateKey: decrypt(server.sshPrivateKey),
      });

      const buffer = await ssh.downloadFile(backup.filePath);
      return { buffer, fileName: backup.name };
    } finally {
      ssh.disconnect();
    }
  },

  // Cleanup expired backups (used by worker)
  // ============ Restore verification ============

  /** On-demand verification from the dashboard (owner/admin). */
  async verifyBackup(
    databaseId: string,
    backupId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    const backup = await databaseRepository.findBackupById(backupId);
    if (!backup || backup.databaseId !== databaseId || !isFinishedBackup(backup.status)) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'backupNotFound') });
    }

    const verification = (backup.metadata as { verification?: BackupVerification }).verification;
    if (verification?.status === 'verifying') {
      return { message: t(locale, 'databases', 'backupVerifyStarted') };
    }

    void this.executeVerify(backupId).catch((error) => {
      logger.error({ error, databaseId, backupId }, 'Backup verification failed to start');
    });

    return { message: t(locale, 'databases', 'backupVerifyStarted') };
  },

  /**
   * Worker entry: verify the latest completed backup of each running database
   * whose last check is older than VERIFY_EVERY_MS. Capped per pass so a fleet
   * of databases doesn't all restore at once.
   */
  async verifyDueBackups(limit = 3): Promise<number> {
    const databases = await databaseRepository.findDatabasesWithBackupEnabled();
    let started = 0;

    for (const database of databases) {
      if (started >= limit) break;
      if (database.status !== 'running') continue;

      const backups = await databaseRepository.findBackupsByDatabase(database.id, 5);
      const latest = backups.find((b) => isFinishedBackup(b.status));
      if (!latest) continue;

      const verification = (latest.metadata as { verification?: BackupVerification }).verification;
      if (verification) {
        const age = Date.now() - new Date(verification.checkedAt).getTime();
        // A run stuck in 'verifying' for over an hour is treated as abandoned.
        if (verification.status === 'verifying' && age < 60 * 60 * 1000) continue;
        if (verification.status !== 'verifying' && age < VERIFY_EVERY_MS) continue;
      }

      try {
        await this.executeVerify(latest.id);
        started++;
      } catch (error) {
        logger.error({ error, databaseId: database.id, backupId: latest.id }, 'Scheduled verification failed');
      }
    }

    return started;
  },

  // Internal: boot a throwaway container from the same image, restore, count, remove.
  async executeVerify(backupId: string): Promise<void> {
    const backup = await databaseRepository.findBackupById(backupId);
    if (!backup || !isFinishedBackup(backup.status) || !backup.filePath) return;

    const database = await databaseRepository.findById(backup.databaseId);
    if (!database?.serverId || !database.containerName) return;

    const setVerification = async (verification: BackupVerification) => {
      await databaseRepository.updateBackup(backupId, {
        metadata: { ...(backup.metadata as Record<string, unknown>), verification },
      });
      wsManager.publish(`database:${database.id}`, {
        type: 'backup:verification',
        data: { databaseId: database.id, backupId, verification },
      }).catch(() => {});
    };

    if (backup.sizeMb && backup.sizeMb > MAX_VERIFY_SIZE_MB) {
      await setVerification({
        status: 'skipped',
        checkedAt: new Date().toISOString(),
        error: `backup is ${backup.sizeMb} MB — above the ${MAX_VERIFY_SIZE_MB} MB verification limit`,
      });
      return;
    }

    const server = await db.query.servers.findFirst({ where: eq(servers.id, database.serverId) });
    if (!server?.ipv4 || !server.sshPrivateKey) return;

    await setVerification({ status: 'verifying', checkedAt: new Date().toISOString() });
    const startedAt = Date.now();

    const ssh = new SSHClient();
    try {
      await ssh.connect({ host: server.ipv4, username: 'root', privateKey: decrypt(server.sshPrivateKey) });

      const script = buildVerifyScript({
        type: database.type as DatabaseType,
        containerName: database.containerName,
        filePath: backup.filePath,
        username: database.username,
        password: decrypt(database.password),
        databaseName: database.databaseName,
        verifyContainerName: `pushify-verify-${backupId.slice(0, 8)}`,
      });
      const result = await ssh.exec(wrapForSsh(script));
      const outcome = parseVerifyOutput(result.stdout, result.code ?? undefined);
      const durationMs = Date.now() - startedAt;

      if (outcome.ok) {
        await setVerification({
          status: 'verified',
          checkedAt: new Date().toISOString(),
          durationMs,
          tables: outcome.tables,
          rows: outcome.rows,
          unit: verifyUnitFor(database.type as DatabaseType),
        });
        logger.info({ databaseId: database.id, backupId, durationMs, ...outcome }, 'Backup restore-verified');
        return;
      }

      throw new Error(outcome.error || 'verification failed');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await setVerification({
        status: 'failed',
        checkedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        error: message,
      });
      logger.error({ error, databaseId: database.id, backupId }, 'Backup verification failed');

      // A backup that doesn't restore is exactly what the owner needs to hear about.
      try {
        const notifyEmail = await resolveBillingNotifyEmail(database.organizationId);
        const org = await organizationRepository.findById(database.organizationId);
        if (notifyEmail && org) {
          await sendBackupVerificationFailedEmail(notifyEmail, org.name, database.name, message, database.id);
        }
      } catch (notifyError) {
        logger.warn({ notifyError, backupId }, 'Could not send verification failure email');
      }
      adminNotify('backup.verify_failed', { databaseId: database.id, backupId, error: message });
    } finally {
      ssh.disconnect();
    }
  },

  async cleanupExpiredBackups() {
    const expiredBackups = await databaseRepository.findExpiredBackups();

    for (const backup of expiredBackups) {
      try {
        // Find the database to get server info
        const database = await databaseRepository.findById(backup.databaseId);
        if (!database?.serverId) {
          await databaseRepository.deleteBackup(backup.id);
          continue;
        }

        const server = await db.query.servers.findFirst({
          where: eq(servers.id, database.serverId),
        });

        // Delete file from server
        if (server?.ipv4 && server.sshPrivateKey && backup.filePath) {
          const ssh = new SSHClient();
          try {
            await ssh.connect({
              host: server.ipv4,
              username: 'root',
              privateKey: decrypt(server.sshPrivateKey),
            });
            await ssh.exec(`rm -f ${backup.filePath}`);
          } catch (error) {
            logger.warn({ error, backupId: backup.id }, 'Failed to delete expired backup file');
          } finally {
            ssh.disconnect();
          }
        }

        // Delete DB record
        await databaseRepository.deleteBackup(backup.id);
        logger.info({ backupId: backup.id, databaseId: backup.databaseId }, 'Expired backup cleaned up');
      } catch (error) {
        logger.error({ error, backupId: backup.id }, 'Error cleaning up expired backup');
      }
    }

    if (expiredBackups.length > 0) {
      logger.info({ count: expiredBackups.length }, 'Expired backups cleanup completed');
    }
  },
};
