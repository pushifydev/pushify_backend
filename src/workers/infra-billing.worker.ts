import { logger } from '../lib/logger';
import { infraBillingService } from '../services/infra-billing.service';

const HOURLY_INTERVAL_MS = 60 * 60 * 1000;

let isRunning = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

export async function startInfraBillingWorker(): Promise<void> {
  if (isRunning) {
    logger.warn('Infra billing worker is already running');
    return;
  }

  isRunning = true;
  logger.info('Infra billing worker started (hourly managed server charges)');

  const tick = async () => {
    try {
      const result = await infraBillingService.processHourlyBilling();
      if (result.charged > 0 || result.stopped > 0) {
        logger.info(result, 'Infra hourly billing tick completed');
      }
    } catch (err) {
      logger.error({ err }, 'Infra hourly billing tick failed');
    }
  };

  await tick();
  intervalHandle = setInterval(tick, HOURLY_INTERVAL_MS);
}

export function stopInfraBillingWorker(): void {
  isRunning = false;
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  logger.info('Infra billing worker stopped');
}
