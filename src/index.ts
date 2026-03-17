import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { app } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { wsManager } from './lib/ws';
import { createWSRoute } from './routes/ws';
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
} from './workers';
import { startNotificationWorker, stopNotificationWorker } from './workers/notification.worker';
import { closeQueues } from './lib/queue';
import {
  startServerStatusWorker,
  stopServerStatusWorker,
  startServerSetupWorker,
  stopServerSetupWorker,
  shutdownQueues as shutdownServerQueues,
} from './queue';

const port = env.PORT;

logger.info(`Starting Pushify API on port ${port}`);

// WebSocket setup
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
app.route('/api/v1/ws', createWSRoute(upgradeWebSocket));

const server = serve({
  fetch: app.fetch,
  port,
});

injectWebSocket(server);
wsManager.initialize();

logger.info(`Pushify API is running on http://localhost:${port}`);

// Start the deployment worker
startDeploymentWorker().catch((error) => {
  logger.error('Failed to start deployment worker:', error);
});

// Start the health check worker
startHealthCheckWorker().catch((error) => {
  logger.error('Failed to start health check worker:', error);
});

// Start the metrics worker
startMetricsWorker().catch((error) => {
  logger.error('Failed to start metrics worker:', error);
});

// Start the log collector worker (collects container logs for persistence)
startLogCollector().catch((error) => {
  logger.error('Failed to start log collector:', error);
});

// Start the backup worker
startBackupWorker().catch((error) => {
  logger.error('Failed to start backup worker:', error);
});

// Start the notification worker (BullMQ - requires Redis)
const notificationWorker = startNotificationWorker();
if (notificationWorker) {
  logger.info('Notification queue worker started');
} else {
  logger.warn('Notification queue worker not started (Redis not configured)');
}

// Start the server status worker (BullMQ - requires Redis)
try {
  startServerStatusWorker();
  logger.info('Server status queue worker started');
} catch (error) {
  logger.warn(`Server status queue worker not started (Redis not configured): ${error}`);
}

// Start the server setup worker (BullMQ - requires Redis)
try {
  startServerSetupWorker();
  logger.info('Server setup queue worker started');
} catch (error) {
  logger.warn(`Server setup queue worker not started (Redis not configured): ${error}`);
}

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  logger.info(`${signal} received, shutting down...`);

  // Stop workers
  stopDeploymentWorker();
  stopHealthCheckWorker();
  stopMetricsWorker();
  stopLogCollector();
  stopBackupWorker();
  await stopNotificationWorker();
  await stopServerStatusWorker();
  await stopServerSetupWorker();

  // Close queues and WebSocket
  await closeQueues();
  await shutdownServerQueues();
  await wsManager.shutdown();

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
