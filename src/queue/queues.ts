import { Queue } from 'bullmq';
import { getRedisConnection } from './connection';

// Queue names
export const QUEUE_NAMES = {
  SERVER_STATUS: 'server-status',
  SERVER_SETUP: 'server-setup',
  DEPLOYMENT: 'deployment',
} as const;

// Job data types
export interface ServerStatusJobData {
  serverId: string;
  providerId: string;
  provider: string;
}

export interface ServerSetupJobData {
  serverId: string;
  providerId: string;
  provider: string;
}

// Queue instances
let serverStatusQueue: Queue<ServerStatusJobData> | null = null;
let serverSetupQueue: Queue<ServerSetupJobData> | null = null;

// Get or create server status queue
export const getServerStatusQueue = (): Queue<ServerStatusJobData> => {
  if (!serverStatusQueue) {
    serverStatusQueue = new Queue<ServerStatusJobData>(QUEUE_NAMES.SERVER_STATUS, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 60, // Max 60 attempts (5 minutes with 5s delay)
        backoff: {
          type: 'fixed',
          delay: 5000, // 5 seconds between attempts
        },
        removeOnComplete: {
          age: 3600, // Keep completed jobs for 1 hour
          count: 100, // Keep last 100 completed jobs
        },
        removeOnFail: {
          age: 86400, // Keep failed jobs for 24 hours
        },
      },
    });
  }
  return serverStatusQueue;
};

// Get or create server setup queue
export const getServerSetupQueue = (): Queue<ServerSetupJobData> => {
  if (!serverSetupQueue) {
    serverSetupQueue = new Queue<ServerSetupJobData>(QUEUE_NAMES.SERVER_SETUP, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 60, // Max 60 attempts (10 minutes with 10s delay)
        backoff: {
          type: 'fixed',
          delay: 10000, // 10 seconds between attempts
        },
        removeOnComplete: {
          age: 3600,
          count: 50,
        },
        removeOnFail: {
          age: 86400,
        },
      },
    });
  }
  return serverSetupQueue;
};

// Close all queues gracefully
export const closeQueues = async (): Promise<void> => {
  const queues = [serverStatusQueue, serverSetupQueue].filter(Boolean) as Queue[];
  await Promise.all(queues.map(q => q.close()));
  serverStatusQueue = null;
  serverSetupQueue = null;
};
