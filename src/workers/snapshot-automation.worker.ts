import { serverSnapshotAutomationService } from '../services/server-snapshot-automation.service';
import { logger } from '../lib/logger';

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let isRunning = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

export async function startSnapshotAutomationWorker(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  logger.info('📸 Snapshot automation worker started');

  const tick = async () => {
    try {
      const result = await serverSnapshotAutomationService.runScheduledSnapshots();
      if (result.created > 0 || result.pruned > 0) {
        logger.info(result, 'Snapshot automation cycle completed');
      }
    } catch (error) {
      logger.error({ err: error }, 'Snapshot automation cycle failed');
    }
  };

  await tick();
  intervalHandle = setInterval(tick, POLL_INTERVAL_MS);
}

export function stopSnapshotAutomationWorker(): void {
  isRunning = false;
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  logger.info('Snapshot automation worker stopped');
}
