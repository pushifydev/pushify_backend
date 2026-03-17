import { db } from '../db';
import { projects } from '../db/schema/projects';
import { deployments } from '../db/schema/deployments';
import { eq, and, desc } from 'drizzle-orm';
import { healthCheckRepository } from '../repositories/healthcheck.repository';
import { healthCheckService } from '../services/healthcheck.service';
import { logger } from '../lib/logger';
import { wsManager } from '../lib/ws';

const POLL_INTERVAL = 10000; // 10 seconds

let isRunning = false;
// Track last check time per project to respect intervals
const lastCheckTimes: Map<string, number> = new Map();
// Track previous status to detect recovery
const previousStatus: Map<string, 'healthy' | 'unhealthy'> = new Map();

/**
 * Start the health check worker
 */
export async function startHealthCheckWorker(): Promise<void> {
  if (isRunning) {
    logger.warn('Health check worker is already running');
    return;
  }

  isRunning = true;
  logger.info('💓 Health check worker started');

  // Start polling
  pollForHealthChecks();
}

/**
 * Stop the health check worker
 */
export function stopHealthCheckWorker(): void {
  isRunning = false;
  logger.info('Health check worker stopped');
}

/**
 * Poll for projects that need health checks
 */
async function pollForHealthChecks(): Promise<void> {
  while (isRunning) {
    try {
      // Get all active health check configs
      const configs = await healthCheckRepository.findActiveHealthChecks();

      for (const config of configs) {
        const now = Date.now();
        const lastCheck = lastCheckTimes.get(config.projectId) || 0;
        const intervalMs = config.intervalSeconds * 1000;

        // Skip if not enough time has passed
        if (now - lastCheck < intervalMs) {
          continue;
        }

        // Run health check in background
        runHealthCheck(config.projectId, config).catch((error) => {
          logger.error({ error, projectId: config.projectId }, 'Error running health check');
        });

        // Update last check time
        lastCheckTimes.set(config.projectId, now);
      }
    } catch (error) {
      logger.error({ err: error }, 'Error polling for health checks');
    }

    await sleep(POLL_INTERVAL);
  }
}

/**
 * Run a health check for a specific project
 */
async function runHealthCheck(
  projectId: string,
  config: {
    endpoint: string;
    timeoutSeconds: number;
    unhealthyThreshold: number;
    autoRestart: boolean;
  }
): Promise<void> {
  try {
    // Get the running deployment for this project
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });

    if (!project || project.status !== 'active') {
      return;
    }

    // Find the latest running deployment
    const runningDeployment = await db.query.deployments.findFirst({
      where: and(
        eq(deployments.projectId, projectId),
        eq(deployments.status, 'running')
      ),
      orderBy: [desc(deployments.createdAt)],
    });

    if (!runningDeployment) {
      return;
    }

    // Get the production URL from project settings
    const productionUrl = (project.settings as Record<string, unknown>)?.productionUrl as string;
    if (!productionUrl) {
      return;
    }

    // Build health check URL
    const healthCheckUrl = `${productionUrl}${config.endpoint}`;

    // Perform health check
    const result = await healthCheckService.performHealthCheck(
      projectId,
      healthCheckUrl,
      config.timeoutSeconds
    );

    // Get previous consecutive failures
    const prevFailures = await healthCheckRepository.getConsecutiveFailures(projectId);

    // Calculate new consecutive failures
    let consecutiveFailures: number;
    let actionTaken: 'none' | 'restarted' | 'notified' = 'none';

    if (result.healthy) {
      consecutiveFailures = 0;

      // Check if this is a recovery (was unhealthy, now healthy)
      if (previousStatus.get(projectId) === 'unhealthy') {
        await healthCheckService.handleRecovery(projectId);
        logger.info({ projectId }, 'Health check recovered');
      }

      previousStatus.set(projectId, 'healthy');
    } else {
      consecutiveFailures = prevFailures + 1;
      previousStatus.set(projectId, 'unhealthy');

      // Handle unhealthy status
      const containerName = `pushify-${project.slug}`;
      actionTaken = await healthCheckService.handleUnhealthy(
        projectId,
        consecutiveFailures,
        config.unhealthyThreshold,
        config.autoRestart,
        containerName
      );
    }

    // Log the result
    await healthCheckRepository.createLog({
      projectId,
      deploymentId: runningDeployment.id,
      status: result.healthy ? 'healthy' : (result.error === 'Timeout' ? 'timeout' : 'unhealthy'),
      responseTimeMs: result.responseTimeMs,
      statusCode: result.statusCode,
      consecutiveFailures,
      actionTaken,
      errorMessage: result.error,
    });

    // Publish health check result via WebSocket
    wsManager.publish(`project:${projectId}`, {
      type: 'healthcheck:result',
      data: {
        projectId,
        healthy: result.healthy,
        responseTimeMs: result.responseTimeMs,
        consecutiveFailures,
      },
    }).catch(() => {});

    logger.debug(
      { projectId, healthy: result.healthy, responseTimeMs: result.responseTimeMs },
      'Health check completed'
    );

    // Clean old logs periodically (every 10th check)
    if (Math.random() < 0.1) {
      await healthCheckRepository.cleanOldLogs(projectId);
    }
  } catch (error) {
    logger.error({ error, projectId }, 'Error performing health check');
  }
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if worker is running
 */
export function isHealthCheckWorkerRunning(): boolean {
  return isRunning;
}
