import { logger } from './logger';
import {
  addDeploymentProcessingJob,
  isQueueAvailable,
} from './queue';

/** How long to wait for Redis before leaving the deployment to the polling worker. */
const QUEUE_TIMEOUT_MS = 5000;

/**
 * Queue a pending deployment for the BullMQ worker (no-op when Redis is unavailable).
 * The row is already `pending`, and the worker also polls the database, so a Redis that is
 * configured but not answering must not keep the caller — an API request — waiting.
 */
export async function scheduleDeploymentProcessing(
  deploymentId: string,
  projectId: string,
): Promise<void> {
  if (!isQueueAvailable()) {
    return;
  }

  try {
    const job = await Promise.race([
      addDeploymentProcessingJob({ deploymentId, projectId }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), QUEUE_TIMEOUT_MS)),
    ]);
    if (job === 'timeout') {
      logger.warn({ deploymentId }, 'Redis did not accept the deployment job in time — the polling worker will pick it up');
      return;
    }
    if (job) {
      logger.debug({ deploymentId, jobId: job.id }, 'Deployment queued for processing');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Job') && message.includes('exists')) {
      return;
    }
    throw err;
  }
}
