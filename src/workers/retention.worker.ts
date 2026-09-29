import { logger } from '../lib/logger';
import { retentionService } from '../services/retention.service';

/** Once a day: drop records past their retention (see retention.service). */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let sweepInProgress = false;

export function startRetentionWorker(): void {
  if (intervalHandle) return;
  const tick = () => {
    if (sweepInProgress) return;
    sweepInProgress = true;
    retentionService
      .sweep()
      .catch((err) => logger.error({ err }, 'Retention sweep failed'))
      .finally(() => {
        sweepInProgress = false;
      });
  };
  intervalHandle = setInterval(tick, SWEEP_INTERVAL_MS);
  setTimeout(tick, 10 * 60 * 1000);
  logger.info('Retention worker started (daily sweep)');
}

export function stopRetentionWorker(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
