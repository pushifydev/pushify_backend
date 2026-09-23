import { databaseRepository } from '../repositories/database.repository';
import { databaseBackupService } from '../services/database-backup.service';
import { certExpiryService } from '../services/cert-expiry.service';
import { logger } from '../lib/logger';

const POLL_INTERVAL = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const VERIFY_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours — each pass verifies a few due backups
const BACKUP_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours
const CERT_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // daily — certificate expiry warnings

let isRunning = false;
let lastCleanup = 0;
let lastVerify = 0;
let lastCertCheck = 0;

/**
 * Start the backup worker
 */
export async function startBackupWorker(): Promise<void> {
  if (isRunning) {
    logger.warn('Backup worker is already running');
    return;
  }

  isRunning = true;
  logger.info('💾 Backup worker started');

  pollForBackups();
}

/**
 * Stop the backup worker
 */
export function stopBackupWorker(): void {
  isRunning = false;
  logger.info('Backup worker stopped');
}

/**
 * Poll for databases that need backups
 */
async function pollForBackups(): Promise<void> {
  while (isRunning) {
    try {
      // Find databases with backup enabled
      const databases = await databaseRepository.findDatabasesWithBackupEnabled();

      for (const database of databases) {
        const now = Date.now();
        const lastBackup = database.lastBackupAt ? new Date(database.lastBackupAt).getTime() : 0;

        // Skip if backed up within threshold
        if (now - lastBackup < BACKUP_THRESHOLD) {
          continue;
        }

        // Perform backup
        try {
          await databaseBackupService.performBackup(database.id, 'automatic');
          logger.info({ databaseId: database.id, name: database.name }, 'Automatic backup started');
        } catch (error) {
          logger.error({ error, databaseId: database.id }, 'Failed to start automatic backup');
        }
      }

      // Restore-verify due backups (a few per pass, weekly per database)
      const now = Date.now();
      if (now - lastVerify >= VERIFY_INTERVAL) {
        try {
          const started = await databaseBackupService.verifyDueBackups();
          if (started > 0) logger.info({ started }, 'Backup restore-verification pass');
          lastVerify = now;
        } catch (error) {
          logger.error({ err: error }, 'Error verifying backups');
        }
      }

      // Certificates about to expire (custom domains, and the auto-subdomain wildcard)
      if (now - lastCertCheck >= CERT_CHECK_INTERVAL) {
        lastCertCheck = now;
        try {
          const result = await certExpiryService.checkDomains();
          certExpiryService.checkPlatformWildcard();
          logger.info(result, 'Certificate expiry check');
        } catch (error) {
          logger.error({ err: error }, 'Error checking certificate expiry');
        }
      }

      // Cleanup expired backups periodically
      // Disk was only ever looked at during a deploy, so a server filling up in between was
      // found when the next deploy failed — with every container on it already starved.
      try {
        const { serverDiskService } = await import('../services/server-disk.service');
        const disks = await serverDiskService.checkAll();
        if (disks.warned > 0) logger.warn(disks, 'Server disk warnings sent');
      } catch (error) {
        logger.error({ err: error }, 'Server disk check failed');
      }

      if (now - lastCleanup >= CLEANUP_INTERVAL) {
        try {
          await databaseBackupService.cleanupExpiredBackups();
          lastCleanup = now;
        } catch (error) {
          logger.error({ err: error }, 'Error cleaning up expired backups');
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Error polling for backups');
    }

    await sleep(POLL_INTERVAL);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if worker is running
 */
export function isBackupWorkerRunning(): boolean {
  return isRunning;
}
