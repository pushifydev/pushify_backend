import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { logger } from './logger';
import { getBullRedisConnection } from './redis-connection';

// Redis connection config — honors the DB index in REDIS_URL so environments sharing a Redis
// host don't collide on the same queue names (see lib/redis-connection.ts).
const getRedisConnection = getBullRedisConnection;

// Queue names
export const QUEUE_NAMES = {
  NOTIFICATIONS: 'notifications',
  DEPLOYMENTS: 'deployments',
  HEALTH_CHECKS: 'health-checks',
  ADMIN_NOTIFY: 'admin-notify',
  SERVER_PATCHES: 'server-patches',
  VULNERABILITY_SCANS: 'vulnerability-scans',
} as const;

// Job types
export interface NotificationJobData {
  type: 'slack' | 'email' | 'webhook' | 'discord';
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
    logTail?: string;
    url?: string;
  };
  config: Record<string, unknown>;
  attempt?: number;
}

export interface DeploymentJobData {
  deploymentId: string;
  projectId: string;
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

export interface AdminNotifyJobData {
  emails: string[];
  subject: string;
  html: string;
  text: string;
}

let adminNotifyQueue: Queue<AdminNotifyJobData> | null = null;

export function getAdminNotifyQueue(): Queue<AdminNotifyJobData> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  if (!adminNotifyQueue) {
    adminNotifyQueue = new Queue<AdminNotifyJobData>(QUEUE_NAMES.ADMIN_NOTIFY, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }

  return adminNotifyQueue;
}

export async function addAdminNotifyJob(data: AdminNotifyJobData): Promise<boolean> {
  const queue = getAdminNotifyQueue();
  if (!queue) return false;
  await queue.add('admin-email', data);
  return true;
}

export interface ServerPatchJobData {
  serverId: string;
  organizationId: string;
  /** Who asked for the run (the request itself is audited as server.patches_requested); null for a scheduled run */
  requestedBy: string | null;
  /**
   * Token of the per-server lock taken when the run was queued (lib/server-patch-lock.ts). A
   * scheduled run has none: the worker takes the lock itself.
   */
  lockToken?: string;
  /** 'auto': queued by the server's automatic security update schedule (lib/server-auto-patch.ts) */
  trigger?: 'manual' | 'auto';
  /** Scheduled runs: how many times this run was put off because a deploy was going on */
  deferrals?: number;
}

let serverPatchQueue: Queue<ServerPatchJobData> | null = null;

/**
 * Security-update runs (POST /servers/:serverId/patches/apply, and the per-server automatic
 * schedules of lib/server-auto-patch.ts). Never retried: an upgrade is not replayed blindly.
 */
export function getServerPatchQueue(): Queue<ServerPatchJobData> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  if (!serverPatchQueue) {
    serverPatchQueue = new Queue<ServerPatchJobData>(QUEUE_NAMES.SERVER_PATCHES, {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 7 * 24 * 3600, count: 500 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }

  return serverPatchQueue;
}

export async function addServerPatchJob(
  data: ServerPatchJobData,
  opts: { delay?: number } = {}
): Promise<Job<ServerPatchJobData> | null> {
  const queue = getServerPatchQueue();
  if (!queue) return null;
  return queue.add('apply', data, opts);
}

export interface VulnerabilityScanJobData {
  deploymentId: string;
  projectId: string;
  /** The server the deploy ran on, where the image is */
  serverId: string;
  /** Image ID (or reference) the deploy started */
  image: string;
}

let vulnerabilityScanQueue: Queue<VulnerabilityScanJobData> | null = null;

/**
 * Image vulnerability scans queued after a successful deploy (lib/vulnerability-scan.ts). One
 * attempt: a failed scan is recorded as failed, the next deploy scans again.
 */
export function getVulnerabilityScanQueue(): Queue<VulnerabilityScanJobData> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  if (!vulnerabilityScanQueue) {
    vulnerabilityScanQueue = new Queue<VulnerabilityScanJobData>(QUEUE_NAMES.VULNERABILITY_SCANS, {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 24 * 3600, count: 500 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }

  return vulnerabilityScanQueue;
}

/** One scan per deployment (deduped by deployment id); null without Redis. */
export async function addVulnerabilityScanJob(
  data: VulnerabilityScanJobData
): Promise<Job<VulnerabilityScanJobData> | null> {
  const queue = getVulnerabilityScanQueue();
  if (!queue) return null;
  return queue.add('scan', data, { jobId: `vulnscan-${data.deploymentId}` });
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

/** Enqueue a pending deployment (deduped by deployment id). */
export async function addDeploymentProcessingJob(
  data: DeploymentJobData,
): Promise<Job<DeploymentJobData> | null> {
  const queue = getDeploymentQueue();
  if (!queue) return null;

  const job = await queue.add('process', data, {
    // BullMQ rejects custom jobIds containing ':' (except repeatable 3-part ids)
    jobId: `deploy-${data.deploymentId}`,
    removeOnComplete: true,
    removeOnFail: false,
  });
  logger.debug({ jobId: job.id, deploymentId: data.deploymentId }, 'Deployment job added to queue');
  return job;
}

/** @deprecated Use addDeploymentProcessingJob */
export async function addDeploymentJob(data: DeploymentJobData): Promise<Job<DeploymentJobData> | null> {
  return addDeploymentProcessingJob(data);
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
    'backup.failed': 1,
    'backup.missed': 1,
    'backup.warning': 2,
    'backup.resolved': 2,
    'backup.success': 3,
    'deployment.started': 3,
    'test': 5,
  };
  return priorities[event] || 3;
}

// Close all queues (for graceful shutdown)
export async function closeQueues(): Promise<void> {
  const queues = [notificationQueue, deploymentQueue, healthCheckQueue, adminNotifyQueue, serverPatchQueue, vulnerabilityScanQueue];

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
  adminNotifyQueue = null;
  serverPatchQueue = null;
  vulnerabilityScanQueue = null;

  logger.info('All queues closed');
}

// Export types
export type { Queue, Worker, Job, QueueEvents };
