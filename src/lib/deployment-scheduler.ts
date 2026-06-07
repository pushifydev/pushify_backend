import { logger } from './logger';
import {
  addDeploymentProcessingJob,
  isQueueAvailable,
} from './queue';

/** Queue a pending deployment for the BullMQ worker (no-op when Redis is unavailable). */
export async function scheduleDeploymentProcessing(
  deploymentId: string,
  projectId: string,
): Promise<void> {
  if (!isQueueAvailable()) {
    return;
  }

  try {
    const job = await addDeploymentProcessingJob({ deploymentId, projectId });
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
