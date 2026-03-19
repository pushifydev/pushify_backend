import { HTTPException } from 'hono/http-exception';
import { databaseRepository } from '../repositories/database.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { t, type SupportedLocale } from '../i18n';
import { decrypt } from '../lib/encryption';
import { SSHClient } from '../utils/ssh';
import { wsManager } from '../lib/ws';
import { logger } from '../lib/logger';
import { db } from '../db';
import { eq } from 'drizzle-orm';
import { servers } from '../db/schema/servers';
import type { DatabaseType } from '../db/schema/databases';

// ============ Helpers ============

function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

function backupFileName(databaseName: string, type: DatabaseType): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = type === 'redis' ? 'rdb' : 'sql.gz';
  return `${databaseName}_${timestamp}.${ext}`;
}

function backupDir(databaseName: string): string {
  return `/opt/pushify/databases/${databaseName}/backups`;
}

function buildDumpCommand(
  containerName: string,
  type: DatabaseType,
  username: string,
  password: string,
  databaseName: string,
  fileName: string,
  backupPath: string
): string {
  const eCont = shellEscape(containerName);
  const eUser = shellEscape(username);
  const ePass = shellEscape(password);
  const eDb = shellEscape(databaseName);
  const eFile = shellEscape(fileName);
  const ePath = shellEscape(backupPath);

  switch (type) {
    case 'postgresql':
      return `docker exec ${eCont} bash -c "pg_dump -U ${eUser} -d ${eDb} | gzip > /tmp/${eFile}" && docker cp ${eCont}:/tmp/${eFile} ${ePath}/`;

    case 'mysql':
      return `docker exec -e MYSQL_PWD=${ePass} ${eCont} bash -c "mysqldump -u ${eUser} ${eDb} | gzip > /tmp/${eFile}" && docker cp ${eCont}:/tmp/${eFile} ${ePath}/`;

    case 'mongodb':
      return `docker exec ${eCont} mongodump --username ${eUser} --password ${ePass} --authenticationDatabase admin --db ${eDb} --archive=/tmp/${eFile} --gzip && docker cp ${eCont}:/tmp/${eFile} ${ePath}/`;

    case 'redis':
      return `docker exec ${eCont} redis-cli -a ${ePass} BGSAVE && sleep 2 && docker cp ${eCont}:/data/dump.rdb ${ePath}/${eFile}`;
  }
}

function buildRestoreCommand(
  containerName: string,
  type: DatabaseType,
  username: string,
  password: string,
  databaseName: string,
  filePath: string
): string {
  const fileName = filePath.split('/').pop()!;

  const eCont = shellEscape(containerName);
  const eUser = shellEscape(username);
  const ePass = shellEscape(password);
  const eDb = shellEscape(databaseName);
  const eFile = shellEscape(fileName);
  const ePath = shellEscape(filePath);

  switch (type) {
    case 'postgresql':
      return `docker cp ${ePath} ${eCont}:/tmp/${eFile} && docker exec ${eCont} bash -c "gunzip -c /tmp/${eFile} | psql -U ${eUser} -d ${eDb}"`;

    case 'mysql':
      return `docker cp ${ePath} ${eCont}:/tmp/${eFile} && docker exec -e MYSQL_PWD=${ePass} ${eCont} bash -c "gunzip -c /tmp/${eFile} | mysql -u ${eUser} ${eDb}"`;

    case 'mongodb':
      return `docker cp ${ePath} ${eCont}:/tmp/${eFile} && docker exec ${eCont} mongorestore --username ${eUser} --password ${ePass} --authenticationDatabase admin --db ${eDb} --archive=/tmp/${eFile} --gzip --drop`;

    case 'redis':
      return `docker exec ${eCont} redis-cli -a ${ePass} SHUTDOWN NOSAVE || true && docker cp ${ePath} ${eCont}:/data/dump.rdb && docker start ${eCont}`;
  }
}

// ============ Service ============

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

    return databaseRepository.findBackupsByDatabase(databaseId);
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
      filePath
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
    filePath: string
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

      // Update backup record
      await databaseRepository.updateBackup(backupId, {
        status: 'completed',
        sizeMb: Math.max(1, Math.round(sizeMb)),
        completedAt: new Date(),
      });

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
    if (!backup || backup.databaseId !== databaseId || backup.status !== 'completed') {
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
      backup.filePath
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
    filePath: string
  ) {
    const ssh = new SSHClient();
    try {
      await ssh.connect({
        host: server.ipv4!,
        username: 'root',
        privateKey: decrypt(server.sshPrivateKey!),
      });

      const restoreCmd = buildRestoreCommand(containerName, type, username, password, databaseName, filePath);
      const result = await ssh.exec(restoreCmd);

      if (result.code !== 0) {
        throw new Error(result.stderr || 'Restore command failed');
      }

      await databaseRepository.updateBackup(backupId, { status: 'restored' as string });

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
    if (!backup || backup.databaseId !== databaseId || backup.status !== 'completed') {
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
