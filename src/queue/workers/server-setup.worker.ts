import { Worker, Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { servers } from '../../db/schema/servers';
import { createRedisConnection } from '../connection';
import { QUEUE_NAMES, type ServerSetupJobData } from '../queues';
import { wsManager } from '../../lib/ws';
import { logger } from '../../lib/logger';

// Check if server setup is complete by polling the health endpoint
async function checkServerHealth(ipv4: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(`http://${ipv4}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      const text = await response.text();
      return text.includes('OK');
    }
    return false;
  } catch {
    return false;
  }
}

// Process server setup check job
async function processServerSetupJob(job: Job<ServerSetupJobData>): Promise<string> {
  const { serverId } = job.data;

  logger.info(`[ServerSetup] Processing job ${job.id} for server ${serverId}`);

  // Get server from database
  const [serverRecord] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  if (!serverRecord) {
    logger.info(`[ServerSetup] Server ${serverId} not found, job complete`);
    return 'server_deleted';
  }

  // Check if setup is already complete or failed
  if (serverRecord.setupStatus === 'completed' || serverRecord.setupStatus === 'failed') {
    logger.info(`[ServerSetup] Server ${serverId} setup already ${serverRecord.setupStatus}`);
    return `already_${serverRecord.setupStatus}`;
  }

  // Check if server has an IP
  if (!serverRecord.ipv4) {
    throw new Error('Server has no IP address yet, will retry');
  }

  // Poll the health endpoint
  const isHealthy = await checkServerHealth(serverRecord.ipv4);

  if (isHealthy) {
    // Setup is complete!
    await db
      .update(servers)
      .set({
        setupStatus: 'completed',
        statusMessage: 'Server setup completed successfully',
        updatedAt: new Date(),
      })
      .where(eq(servers.id, serverId));

    // Publish setup completed via WebSocket
    wsManager.publish(`server:${serverId}`, {
      type: 'server:setup',
      data: { serverId, status: 'running', setupStatus: 'completed', statusMessage: 'Server setup completed successfully' },
    }).catch(() => {});

    logger.info(`[ServerSetup] Server ${serverId} setup completed!`);
    return 'completed';
  }

  // Check how many attempts we've made
  const attemptsMade = job.attemptsMade;
  const maxAttempts = job.opts.attempts || 60;

  // If we've exhausted most attempts (allow up to 10 minutes of checking)
  if (attemptsMade >= maxAttempts - 1) {
    await db
      .update(servers)
      .set({
        setupStatus: 'failed',
        statusMessage: 'Server setup timed out - health check not responding',
        updatedAt: new Date(),
      })
      .where(eq(servers.id, serverId));

    // Publish setup failed via WebSocket
    wsManager.publish(`server:${serverId}`, {
      type: 'server:setup',
      data: { serverId, status: 'running', setupStatus: 'failed', statusMessage: 'Server setup timed out - health check not responding' },
    }).catch(() => {});

    logger.info(`[ServerSetup] Server ${serverId} setup failed after ${attemptsMade} attempts`);
    return 'failed';
  }

  // Still waiting for setup to complete, throw to retry
  throw new Error(`Server setup not complete yet (attempt ${attemptsMade + 1}/${maxAttempts})`);
}

// Create and start the worker
let worker: Worker<ServerSetupJobData> | null = null;

export const startServerSetupWorker = (): Worker<ServerSetupJobData> => {
  if (worker) {
    return worker;
  }

  worker = new Worker<ServerSetupJobData>(
    QUEUE_NAMES.SERVER_SETUP,
    processServerSetupJob,
    {
      connection: createRedisConnection(),
      concurrency: 5,
    }
  );

  worker.on('completed', (job, result) => {
    logger.info(`[ServerSetup] Job ${job.id} completed with result: ${result}`);
  });

  worker.on('failed', (job, err) => {
    if (job) {
      const attemptsLeft = (job.opts.attempts || 1) - job.attemptsMade;
      if (attemptsLeft > 0) {
        logger.info(`[ServerSetup] Job ${job.id} failed, ${attemptsLeft} attempts left: ${err.message}`);
      } else {
        console.error(`[ServerSetup] Job ${job.id} failed permanently: ${err.message}`);
      }
    }
  });

  worker.on('error', (err) => {
    console.error('[ServerSetup] Worker error:', err);
  });

  logger.info('[ServerSetup] Worker started');
  return worker;
};

export const stopServerSetupWorker = async (): Promise<void> => {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('[ServerSetup] Worker stopped');
  }
};
