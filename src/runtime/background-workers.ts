import { logger } from '../lib/logger';
import { env } from '../config/env';
import {
  startDeploymentWorker,
  stopDeploymentWorker,
  startHealthCheckWorker,
  stopHealthCheckWorker,
  startMetricsWorker,
  stopMetricsWorker,
  startLogCollector,
  stopLogCollector,
  startBackupWorker,
  stopBackupWorker,
  startInfraBillingWorker,
  stopInfraBillingWorker,
  startSnapshotAutomationWorker,
  stopSnapshotAutomationWorker,
} from '../workers';
import { startNotificationWorker, stopNotificationWorker } from '../workers/notification.worker';
import { reconcileProvisioningServers } from '../services/server-reconcile.service';
import { closeQueues } from '../lib/queue';
import {
  startServerStatusWorker,
  stopServerStatusWorker,
  startServerSetupWorker,
  stopServerSetupWorker,
  shutdownQueues as shutdownServerQueues,
} from '../queue';

// Periodic provisioning-reconcile sweep. Safety net that recovers managed servers
// stuck at `provisioning` after the one-shot `server-status` poll job has exhausted.
const RECONCILE_INTERVAL_MS = 30000;
let reconcileInterval: ReturnType<typeof setInterval> | null = null;
let isReconciling = false; // guard so overlapping/slow sweeps never run concurrently

export async function startBackgroundWorkers(): Promise<void> {
  logger.info({ role: env.PROCESS_ROLE }, 'Starting background workers');

  await startDeploymentWorker().catch((error) => {
    logger.error({ err: error }, 'Failed to start deployment worker');
  });

  await startHealthCheckWorker().catch((error) => {
    logger.error({ err: error }, 'Failed to start health check worker');
  });

  await startInfraBillingWorker().catch((error) => {
    logger.error({ err: error }, 'Failed to start infra billing worker');
  });

  await startSnapshotAutomationWorker().catch((error) => {
    logger.error({ err: error }, 'Failed to start snapshot automation worker');
  });

  await startMetricsWorker().catch((error) => {
    logger.error({ err: error }, 'Failed to start metrics worker');
  });

  await startLogCollector().catch((error) => {
    logger.error({ err: error }, 'Failed to start log collector');
  });

  await startBackupWorker().catch((error) => {
    logger.error({ err: error }, 'Failed to start backup worker');
  });

  const notificationWorker = startNotificationWorker();
  if (notificationWorker) {
    logger.info('Notification queue worker started');
  } else {
    logger.warn('Notification queue worker not started (Redis not configured)');
  }

  try {
    startServerStatusWorker();
    logger.info('Server status queue worker started');
  } catch (error) {
    logger.warn({ err: error }, 'Server status queue worker not started');
  }

  try {
    startServerSetupWorker();
    logger.info('Server setup queue worker started');
  } catch (error) {
    logger.warn({ err: error }, 'Server setup queue worker not started');
  }

  // Start the provisioning reconcile sweep. Best-effort: the callback never throws,
  // and the `isReconciling` guard skips a tick if the previous sweep is still running.
  if (!reconcileInterval) {
    reconcileInterval = setInterval(() => {
      if (isReconciling) return;
      isReconciling = true;
      reconcileProvisioningServers()
        .then((res) => {
          if (res.recovered > 0 || res.failed > 0) {
            logger.info(res, 'Provisioning reconcile sweep processed servers');
          }
        })
        .catch((error) => {
          logger.error({ err: error }, 'Provisioning reconcile sweep failed');
        })
        .finally(() => {
          isReconciling = false;
        });
    }, RECONCILE_INTERVAL_MS);
    logger.info('Provisioning reconcile sweep started');
  }
}

export async function stopBackgroundWorkers(): Promise<void> {
  if (reconcileInterval) {
    clearInterval(reconcileInterval);
    reconcileInterval = null;
  }
  stopDeploymentWorker();
  stopHealthCheckWorker();
  stopMetricsWorker();
  stopLogCollector();
  stopBackupWorker();
  stopInfraBillingWorker();
  stopSnapshotAutomationWorker();
  await stopNotificationWorker();
  await stopServerStatusWorker();
  await stopServerSetupWorker();
  await closeQueues();
  await shutdownServerQueues();
}
