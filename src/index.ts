import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { app } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { wsManager } from './lib/ws';
import { createWSRoute } from './routes/ws';
import { closeOptionalRedis } from './lib/redis-client';
import { closeDatabasePool } from './db';
import { startBackgroundWorkers, stopBackgroundWorkers } from './runtime/background-workers';
import { runStartupChecks } from './runtime/startup-checks';
import { runsApiServer, runsBackgroundWorkers } from './runtime/process-role';

await runStartupChecks(env.PROCESS_ROLE);

if (!runsApiServer()) {
  logger.error(
    { role: env.PROCESS_ROLE },
    'index.ts is for API only — use worker.ts with PROCESS_ROLE=worker for background jobs',
  );
  process.exit(1);
}

const port = env.PORT;

logger.info({ port, role: env.PROCESS_ROLE }, 'Starting Pushify API');

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
app.route('/api/v1/ws', createWSRoute(upgradeWebSocket));

const server = serve({
  fetch: app.fetch,
  port,
});

injectWebSocket(server);
wsManager.initialize();

logger.info(`Pushify API is running on http://localhost:${port}`);

if (runsBackgroundWorkers()) {
  await startBackgroundWorkers();
} else {
  logger.info('Background workers disabled on this process (run worker.ts separately)');
}

async function gracefulShutdown(signal: string) {
  logger.info(`${signal} received, shutting down...`);

  if (runsBackgroundWorkers()) {
    await stopBackgroundWorkers();
  }

  await wsManager.shutdown();
  await closeDatabasePool();
  await closeOptionalRedis();

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
