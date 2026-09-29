import { logger } from '../lib/logger';
import { deletionPurgeService } from '../services/deletion-purge.service';

/**
 * Sends the one-week reminders and purges organizations and accounts whose 30 days are up.
 * Hourly, so a purge lands within the hour of its date and a failed step is retried soon.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let sweepInProgress = false;

export function startDeletionPurgeWorker(): void {
  if (intervalHandle) return;

  const tick = () => {
    if (sweepInProgress) return;
    sweepInProgress = true;
    deletionPurgeService
      .sweep()
      .then((stats) => {
        if (stats.reminded || stats.organizations || stats.accounts || stats.pending) {
          logger.info(stats, 'Deletion purge sweep');
        }
      })
      .catch((err) => logger.error({ err }, 'Deletion purge sweep failed'))
      .finally(() => {
        sweepInProgress = false;
      });
  };

  intervalHandle = setInterval(tick, SWEEP_INTERVAL_MS);
  setTimeout(tick, 2 * 60 * 1000);
  logger.info('Deletion purge worker started (hourly sweep)');
}

export function stopDeletionPurgeWorker(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
