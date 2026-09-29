import { logger } from '../lib/logger';
import { stoppedServerService } from '../services/stopped-server.service';

/** Hourly: warn about, then delete, managed servers left off for non-payment (see the service). */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let sweepInProgress = false;

export function startStoppedServerWorker(): void {
  if (intervalHandle) return;
  const tick = () => {
    if (sweepInProgress) return;
    sweepInProgress = true;
    stoppedServerService
      .sweep()
      .then((stats) => {
        if (stats.warned || stats.deleted) logger.info(stats, 'Stopped server sweep');
      })
      .catch((err) => logger.error({ err }, 'Stopped server sweep failed'))
      .finally(() => {
        sweepInProgress = false;
      });
  };
  intervalHandle = setInterval(tick, SWEEP_INTERVAL_MS);
  setTimeout(tick, 5 * 60 * 1000);
  logger.info('Stopped server worker started (hourly sweep)');
}

export function stopStoppedServerWorker(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
