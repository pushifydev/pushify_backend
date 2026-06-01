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
import { closeQueues } from '../lib/queue';
import {
  startServerStatusWorker,
  stopServerStatusWorker,
  startServerSetupWorker,
  stopServerSetupWorker,
  shutdownQueues as shutdownServerQueues,
} from '../queue';

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
}

export async function stopBackgroundWorkers(): Promise<void> {
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
