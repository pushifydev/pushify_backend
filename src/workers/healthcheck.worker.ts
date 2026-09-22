import { appHealthService } from '../services/app-health.service';
import { logger } from '../lib/logger';

/**
 * Watches every deployed app, not only the ones with a `health_checks` row: services/
 * app-health.service.ts decides what to check, when, and who hears about it.
 */

const POLL_INTERVAL = 15000;

let isRunning = false;
/** projectId → last check (ms); each project keeps its own interval */
const lastChecked = new Map<string, number>();

export async function startHealthCheckWorker(): Promise<void> {
  if (isRunning) {
    logger.warn('Health check worker is already running');
    return;
  }

  isRunning = true;
  logger.info('💓 Health check worker started');
  pollForHealthChecks();
}

export function stopHealthCheckWorker(): void {
  isRunning = false;
  logger.info('Health check worker stopped');
}

async function pollForHealthChecks(): Promise<void> {
  while (isRunning) {
    try {
      const { checked, down } = await appHealthService.checkDue(lastChecked);
      if (down > 0) logger.warn({ checked, down }, 'Apps not answering');
    } catch (error) {
      logger.error({ err: error }, 'Error polling for health checks');
    }

    await sleep(POLL_INTERVAL);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isHealthCheckWorkerRunning(): boolean {
  return isRunning;
}
