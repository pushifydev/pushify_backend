import { databaseRepository } from '../repositories/database.repository';
import { databaseBackupService } from '../services/database-backup.service';
import { logger } from '../lib/logger';

const POLL_INTERVAL = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const BACKUP_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours

let isRunning = false;
let lastCleanup = 0;

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

      // Cleanup expired backups periodically
      const now = Date.now();
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
