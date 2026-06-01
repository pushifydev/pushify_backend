import { env } from './config/env';
import { logger } from './lib/logger';
import { closeOptionalRedis } from './lib/redis-client';
import { closeDatabasePool } from './db';
import { startBackgroundWorkers, stopBackgroundWorkers } from './runtime/background-workers';
import { runStartupChecks } from './runtime/startup-checks';

if (env.PROCESS_ROLE !== 'worker' && env.PROCESS_ROLE !== 'all') {
  logger.error(
    { role: env.PROCESS_ROLE },
    'worker.ts must run with PROCESS_ROLE=worker (or all for local dev)',
  );
  process.exit(1);
}

logger.info({ role: env.PROCESS_ROLE }, 'Starting Pushify worker process');

await runStartupChecks('worker');
await startBackgroundWorkers();

async function gracefulShutdown(signal: string) {
  logger.info({ signal }, 'Worker shutting down');
  await stopBackgroundWorkers();
  await closeDatabasePool();
  await closeOptionalRedis();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
