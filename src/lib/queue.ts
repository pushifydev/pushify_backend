import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { logger } from './logger';
import { env } from '../config/env';

// Redis connection config
const getRedisConnection = () => {
  if (!env.REDIS_URL) {
    return null;
  }

  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: parseInt(url.port) || 6379,
    password: url.password || undefined,
    username: url.username || undefined,
  };
};

// Queue names
export const QUEUE_NAMES = {
  NOTIFICATIONS: 'notifications',
  DEPLOYMENTS: 'deployments',
  HEALTH_CHECKS: 'health-checks',
} as const;

// Job types
export interface NotificationJobData {
  type: 'slack' | 'email' | 'webhook';
  channelId: string;
  payload: {
    event: string;
    projectId: string;
    projectName: string;
    deploymentId?: string;
    commitHash?: string;
    branch?: string;
    status?: string;
    message?: string;
    url?: string;
  };
  config: Record<string, unknown>;
  attempt?: number;
}

export interface DeploymentJobData {
  deploymentId: string;
  projectId: string;
  action: 'build' | 'deploy' | 'cleanup';
}

export interface HealthCheckJobData {
  projectId: string;
  deploymentId?: string;
}

// Queue instances (lazy initialized)
let notificationQueue: Queue<NotificationJobData> | null = null;
let deploymentQueue: Queue<DeploymentJobData> | null = null;
let healthCheckQueue: Queue<HealthCheckJobData> | null = null;

// Check if queue is available
export function isQueueAvailable(): boolean {
  return !!getRedisConnection();
}

// Get or create notification queue
export function getNotificationQueue(): Queue<NotificationJobData> | null {
  const connection = getRedisConnection();
  if (!connection) {
    logger.warn('Redis not configured, queue unavailable');
    return null;
  }

  if (!notificationQueue) {
    notificationQueue = new Queue<NotificationJobData>(QUEUE_NAMES.NOTIFICATIONS, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000, // 2s, 4s, 8s
        },
        removeOnComplete: {
          age: 24 * 3600, // Keep completed jobs for 24 hours
          count: 1000,
        },
        removeOnFail: {
          age: 7 * 24 * 3600, // Keep failed jobs for 7 days
        },
      },
    });

    logger.info('Notification queue initialized');
  }

  return notificationQueue;
}

// Get or create deployment queue
export function getDeploymentQueue(): Queue<DeploymentJobData> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  if (!deploymentQueue) {
    deploymentQueue = new Queue<DeploymentJobData>(QUEUE_NAMES.DEPLOYMENTS, {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'fixed',
          delay: 5000,
        },
        removeOnComplete: {
          age: 24 * 3600,
          count: 500,
        },
        removeOnFail: {
          age: 7 * 24 * 3600,
        },
      },
    });

    logger.info('Deployment queue initialized');
  }

  return deploymentQueue;
}

// Get or create health check queue
export function getHealthCheckQueue(): Queue<HealthCheckJobData> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  if (!healthCheckQueue) {
    healthCheckQueue = new Queue<HealthCheckJobData>(QUEUE_NAMES.HEALTH_CHECKS, {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: {
          age: 3600, // 1 hour
          count: 100,
        },
        removeOnFail: {
          age: 24 * 3600,
        },
      },
    });

    logger.info('Health check queue initialized');
  }

  return healthCheckQueue;
}

// Add notification job to queue
export async function addNotificationJob(data: NotificationJobData): Promise<Job<NotificationJobData> | null> {
  const queue = getNotificationQueue();
  if (!queue) {
    logger.warn('Queue unavailable, notification will be sent synchronously');
    return null;
  }

  const job = await queue.add(`notification-${data.type}`, data, {
    priority: getPriority(data.payload.event),
  });

  logger.debug({ jobId: job.id, type: data.type, event: data.payload.event }, 'Notification job added to queue');
  return job;
}

// Add deployment job to queue
export async function addDeploymentJob(data: DeploymentJobData): Promise<Job<DeploymentJobData> | null> {
  const queue = getDeploymentQueue();
  if (!queue) return null;

  const job = await queue.add(`deployment-${data.action}`, data);
  logger.debug({ jobId: job.id, deploymentId: data.deploymentId }, 'Deployment job added to queue');
  return job;
}

// Add health check job to queue
export async function addHealthCheckJob(data: HealthCheckJobData): Promise<Job<HealthCheckJobData> | null> {
  const queue = getHealthCheckQueue();
  if (!queue) return null;

  const job = await queue.add('health-check', data);
  return job;
}

// Get priority based on event type
function getPriority(event: string): number {
  // Lower number = higher priority
  const priorities: Record<string, number> = {
    'deployment.failed': 1,
    'health.unhealthy': 1,
    'deployment.success': 2,
    'health.recovered': 2,
    'deployment.started': 3,
    'test': 5,
  };
  return priorities[event] || 3;
}

// Close all queues (for graceful shutdown)
export async function closeQueues(): Promise<void> {
  const queues = [notificationQueue, deploymentQueue, healthCheckQueue];

  await Promise.all(
    queues.filter(Boolean).map(async (queue) => {
      if (queue) {
        await queue.close();
      }
    })
  );

  notificationQueue = null;
  deploymentQueue = null;
  healthCheckQueue = null;

  logger.info('All queues closed');
}

// Export types
export type { Queue, Worker, Job, QueueEvents };
