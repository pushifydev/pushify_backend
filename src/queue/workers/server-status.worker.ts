import { Worker, Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { servers } from '../../db/schema/servers';
import { createProvider, type ProviderType } from '../../providers';
import { createRedisConnection } from '../connection';
import { QUEUE_NAMES, getServerSetupQueue, type ServerStatusJobData } from '../queues';
import { wsManager } from '../../lib/ws';

// Get provider API token from environment
function getProviderToken(provider: ProviderType): string {
  switch (provider) {
    case 'hetzner':
      return process.env.HETZNER_API_TOKEN || '';
    case 'digitalocean':
      return process.env.DIGITALOCEAN_API_TOKEN || '';
    case 'aws':
      return process.env.AWS_ACCESS_KEY || '';
    default:
      throw new Error(`No API token configured for provider: ${provider}`);
  }
}

// Process server status check job
async function processServerStatusJob(job: Job<ServerStatusJobData>): Promise<string> {
  const { serverId, providerId, provider } = job.data;

  console.log(`[ServerStatus] Processing job ${job.id} for server ${serverId}`);

  // Check if server still exists in database
  const [serverRecord] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  if (!serverRecord) {
    console.log(`[ServerStatus] Server ${serverId} not found, job complete`);
    return 'server_deleted';
  }

  // Check if server is already in a terminal state
  if (['running', 'error', 'stopped', 'deleting'].includes(serverRecord.status)) {
    console.log(`[ServerStatus] Server ${serverId} is already in state: ${serverRecord.status}`);
    return `already_${serverRecord.status}`;
  }

  // Get provider instance
  const apiToken = getProviderToken(provider as ProviderType);
  if (!apiToken) {
    throw new Error(`No API token for provider: ${provider}`);
  }

  const providerInstance = createProvider(provider as ProviderType, apiToken);

  // Get latest status from provider
  const providerServer = await providerInstance.getServer(providerId);

  // Update database with latest info
  await db
    .update(servers)
    .set({
      ipv4: providerServer.ipv4,
      ipv6: providerServer.ipv6,
      privateIp: providerServer.privateIp,
      status: providerServer.status,
      vcpus: providerServer.vcpus,
      memoryMb: providerServer.memoryMb,
      diskGb: providerServer.diskGb,
      providerData: providerServer.providerData,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(servers.id, serverId));

  // Publish server status via WebSocket
  wsManager.publish(`server:${serverId}`, {
    type: 'server:status',
    data: {
      serverId,
      status: providerServer.status,
      ipv4: providerServer.ipv4 || undefined,
    },
  }).catch(() => {});

  console.log(`[ServerStatus] Server ${serverId} status updated to: ${providerServer.status}`);

  // If server is still provisioning, throw error to retry
  if (providerServer.status === 'provisioning') {
    throw new Error('Server still provisioning, will retry');
  }

  // If server is now running, queue setup check job
  if (providerServer.status === 'running' && providerServer.ipv4) {
    console.log(`[ServerStatus] Server ${serverId} is running, queuing setup check`);

    // Update setupStatus to 'installing'
    await db
      .update(servers)
      .set({
        setupStatus: 'installing',
        updatedAt: new Date(),
      })
      .where(eq(servers.id, serverId));

    // Add setup check job with delay to allow cloud-init to run (Docker + Nginx installation)
    const setupQueue = getServerSetupQueue();
    await setupQueue.add(
      `server-setup-${serverId}`,
      {
        serverId,
        providerId,
        provider,
      },
      {
        jobId: `server-setup-${serverId}`,
        delay: 60000, // Wait 60 seconds before first check (Docker installation takes time)
      }
    );
  }

  return providerServer.status;
}

// Create and start the worker
let worker: Worker<ServerStatusJobData> | null = null;

export const startServerStatusWorker = (): Worker<ServerStatusJobData> => {
  if (worker) {
    return worker;
  }

  worker = new Worker<ServerStatusJobData>(
    QUEUE_NAMES.SERVER_STATUS,
    processServerStatusJob,
    {
      connection: createRedisConnection(),
      concurrency: 5, // Process up to 5 jobs concurrently
    }
  );

  worker.on('completed', (job, result) => {
    console.log(`[ServerStatus] Job ${job.id} completed with result: ${result}`);
  });

  worker.on('failed', (job, err) => {
    if (job) {
      const attemptsLeft = (job.opts.attempts || 1) - job.attemptsMade;
      if (attemptsLeft > 0) {
        console.log(`[ServerStatus] Job ${job.id} failed, ${attemptsLeft} attempts left: ${err.message}`);
      } else {
        console.error(`[ServerStatus] Job ${job.id} failed permanently: ${err.message}`);
      }
    }
  });

  worker.on('error', (err) => {
    console.error('[ServerStatus] Worker error:', err);
  });

  console.log('[ServerStatus] Worker started');
  return worker;
};

export const stopServerStatusWorker = async (): Promise<void> => {
  if (worker) {
    await worker.close();
    worker = null;
    console.log('[ServerStatus] Worker stopped');
  }
};
