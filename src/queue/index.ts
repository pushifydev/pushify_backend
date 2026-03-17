// Queue exports
export { getRedisConnection, closeRedisConnection } from './connection';
export {
  QUEUE_NAMES,
  getServerStatusQueue,
  getServerSetupQueue,
  closeQueues,
  type ServerStatusJobData,
  type ServerSetupJobData,
} from './queues';
export { startServerStatusWorker, stopServerStatusWorker } from './workers/server-status.worker';
export { startServerSetupWorker, stopServerSetupWorker } from './workers/server-setup.worker';

// Initialize all workers
import { startServerStatusWorker } from './workers/server-status.worker';
import { startServerSetupWorker } from './workers/server-setup.worker';

let workersStarted = false;

export const startAllWorkers = (): void => {
  if (workersStarted) return;

  try {
    startServerStatusWorker();
    startServerSetupWorker();
    workersStarted = true;
    console.log('[Queue] All workers started');
  } catch (error) {
    console.error('[Queue] Failed to start workers:', error);
  }
};

// Graceful shutdown
import { closeQueues } from './queues';
import { closeRedisConnection } from './connection';
import { stopServerStatusWorker } from './workers/server-status.worker';
import { stopServerSetupWorker } from './workers/server-setup.worker';

export const shutdownQueues = async (): Promise<void> => {
  console.log('[Queue] Shutting down...');

  await stopServerStatusWorker();
  await stopServerSetupWorker();
  await closeQueues();
  await closeRedisConnection();

  workersStarted = false;
  console.log('[Queue] Shutdown complete');
};
