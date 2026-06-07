import { Worker, type Job } from 'bullmq';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { QUEUE_NAMES, type DeploymentJobData } from '../lib/queue';
import { tryAcquireDeploySlots, releaseDeploySlots } from '../lib/deploy-concurrency';
import {
  tryHoldDeployWorkerLeadership,
} from '../lib/deploy-worker-lock';
import { db } from '../db';
import { deployments } from '../db/schema/deployments';
import { eq } from 'drizzle-orm';
import { scheduleDeploymentProcessing } from '../lib/deployment-scheduler';

const RECONCILE_INTERVAL_MS = 15_000;
const SLOT_RETRY_DELAY_MS = 5000;

function getRedisConnection() {
  if (!env.REDIS_URL) return null;
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: parseInt(url.port, 10) || 6379,
    password: url.password || undefined,
    username: url.username || undefined,
  };
}

let deploymentQueueWorker: Worker<DeploymentJobData> | null = null;
let reconcileRunning = false;

async function processDeploymentQueueJob(job: Job<DeploymentJobData>): Promise<void> {
  const { executeDeploymentJob, loadDeploymentJobById } = await import('./deployment.worker');
  const { deploymentId } = job.data;
  const row = await loadDeploymentJobById(deploymentId);

  if (!row) {
    logger.warn({ deploymentId, jobId: job.id }, 'Deployment job row not found');
    return;
  }

  if (row.status !== 'pending') {
    logger.debug({ deploymentId, status: row.status }, 'Skipping deployment job — not pending');
    return;
  }

  const serverId = row.serverId || '__local__';
  const acquired = await tryAcquireDeploySlots(serverId);
  if (!acquired) {
    await job.moveToDelayed(Date.now() + SLOT_RETRY_DELAY_MS);
    return;
  }

  try {
    await executeDeploymentJob(row);
  } finally {
    await releaseDeploySlots(serverId);
  }
}

async function reconcilePendingDeployments(): Promise<void> {
  while (reconcileRunning) {
    try {
      const isLeader = await tryHoldDeployWorkerLeadership();
      if (isLeader) {
        const { refreshPendingDeploymentQueueLogs } = await import('./deployment.worker');
        await refreshPendingDeploymentQueueLogs();

        const pending = await db
          .select({
            id: deployments.id,
            projectId: deployments.projectId,
          })
          .from(deployments)
          .where(eq(deployments.status, 'pending'))
          .limit(50);

        for (const row of pending) {
          await scheduleDeploymentProcessing(row.id, row.projectId);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Deployment reconcile loop error');
    }

    await new Promise((r) => setTimeout(r, RECONCILE_INTERVAL_MS));
  }
}

export function startDeploymentQueueWorker(): Worker<DeploymentJobData> | null {
  const connection = getRedisConnection();
  if (!connection) {
    return null;
  }

  if (deploymentQueueWorker) {
    return deploymentQueueWorker;
  }

  deploymentQueueWorker = new Worker<DeploymentJobData>(
    QUEUE_NAMES.DEPLOYMENTS,
    processDeploymentQueueJob,
    {
      connection,
      concurrency: env.MAX_CONCURRENT_DEPLOYS_TOTAL,
    },
  );

  deploymentQueueWorker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, deploymentId: job?.data.deploymentId, err: error.message },
      'Deployment queue job failed',
    );
  });

  deploymentQueueWorker.on('error', (error) => {
    logger.error({ err: error }, 'Deployment queue worker error');
  });

  reconcileRunning = true;
  void reconcilePendingDeployments();

  logger.info(
    { concurrency: env.MAX_CONCURRENT_DEPLOYS_TOTAL },
    'Deployment BullMQ worker started',
  );

  return deploymentQueueWorker;
}

export async function stopDeploymentQueueWorker(): Promise<void> {
  reconcileRunning = false;

  if (deploymentQueueWorker) {
    await deploymentQueueWorker.close();
    deploymentQueueWorker = null;
    logger.info('Deployment BullMQ worker stopped');
  }
}
