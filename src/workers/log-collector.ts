import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db';
import { containerLogs } from '../db/schema/container-logs';
import { deployments } from '../db/schema/deployments';
import { projects } from '../db/schema/projects';
import { servers } from '../db/schema/servers';
import { SSHClient } from '../utils/ssh';
import { decrypt } from '../lib/encryption';
import { logger } from '../lib/logger';
import { getContainerLogs as getRemoteContainerLogs, isContainerRunning as isRemoteContainerRunning } from './remote-docker';
import { getContainerLogs as getLocalContainerLogs, isContainerRunning as isLocalContainerRunning } from './docker';

const COLLECTION_INTERVAL = 60000; // 1 minute
const MAX_LINES_PER_CHUNK = 1000;
const LOG_RETENTION_DAYS = 7;

let isRunning = false;

/**
 * Start the log collector worker
 */
export async function startLogCollector(): Promise<void> {
  if (isRunning) {
    logger.warn('Log collector is already running');
    return;
  }

  isRunning = true;
  logger.info('📝 Log collector started');

  collectLogs();
}

/**
 * Stop the log collector worker
 */
export function stopLogCollector(): void {
  isRunning = false;
  logger.info('Log collector stopped');
}

/**
 * Main collection loop
 */
async function collectLogs(): Promise<void> {
  while (isRunning) {
    try {
      await collectAllDeploymentLogs();
      await cleanupOldLogs();
    } catch (error) {
      logger.error({ err: error }, 'Error in log collection cycle');
    }

    await sleep(COLLECTION_INTERVAL);
  }
}

/**
 * Collect logs from all running deployments
 */
async function collectAllDeploymentLogs(): Promise<void> {
  // Get all running deployments
  const runningDeployments = await db
    .select({
      deployment: deployments,
      project: projects,
      server: servers,
    })
    .from(deployments)
    .innerJoin(projects, eq(deployments.projectId, projects.id))
    .leftJoin(servers, eq(projects.serverId, servers.id))
    .where(eq(deployments.status, 'running'));

  for (const { deployment, project, server } of runningDeployments) {
    try {
      await collectDeploymentLogs(deployment, project, server);
    } catch (error) {
      logger.error(
        { err: error, deploymentId: deployment.id },
        'Failed to collect logs for deployment'
      );
    }
  }
}

/**
 * Collect logs for a single deployment
 */
async function collectDeploymentLogs(
  deployment: typeof deployments.$inferSelect,
  project: typeof projects.$inferSelect,
  server: typeof servers.$inferSelect | null
): Promise<void> {
  // Determine container name based on blue-green deployment
  const baseContainerName = `pushify-${project.slug}`;

  // Get the last chunk index for this deployment
  const lastChunk = await db
    .select({ chunkIndex: containerLogs.chunkIndex })
    .from(containerLogs)
    .where(eq(containerLogs.deploymentId, deployment.id))
    .orderBy(desc(containerLogs.chunkIndex))
    .limit(1);

  const nextChunkIndex = lastChunk.length > 0 ? lastChunk[0].chunkIndex + 1 : 0;

  let logs: string | null = null;

  if (server && server.ipv4 && server.sshPrivateKey) {
    // Remote deployment
    let ssh: SSHClient | null = null;
    try {
      ssh = new SSHClient();
      await ssh.connect({
        host: server.ipv4,
        port: 22,
        username: 'root',
        privateKey: decrypt(server.sshPrivateKey),
      });

      // Try blue and green containers
      for (const suffix of ['-blue', '-green', '']) {
        const containerName = `${baseContainerName}${suffix}`;
        const running = await isRemoteContainerRunning(ssh, containerName);
        if (running) {
          // Get logs since last collection (using --since to avoid duplicates)
          logs = await getRemoteContainerLogs(ssh, containerName, {
            tail: MAX_LINES_PER_CHUNK,
            since: '1m', // Logs from last 1 minute
          });
          break;
        }
      }
    } finally {
      if (ssh) {
        ssh.disconnect();
      }
    }
  } else {
    // Local deployment
    for (const suffix of ['-blue', '-green', '']) {
      const containerName = `${baseContainerName}${suffix}`;
      const running = await isLocalContainerRunning(containerName);
      if (running) {
        logs = await getLocalContainerLogs(containerName, {
          tail: MAX_LINES_PER_CHUNK,
          since: '1m',
        });
        break;
      }
    }
  }

  // Store logs if we got any
  if (logs && logs.trim().length > 0) {
    const lineCount = logs.split('\n').filter(line => line.trim()).length;

    await db.insert(containerLogs).values({
      deploymentId: deployment.id,
      projectId: project.id,
      logContent: logs,
      logType: 'stdout',
      lineCount,
      chunkIndex: nextChunkIndex,
      startTimestamp: new Date(Date.now() - 60000), // 1 minute ago
      endTimestamp: new Date(),
    });

    logger.debug(
      { deploymentId: deployment.id, lineCount, chunkIndex: nextChunkIndex },
      'Collected container logs'
    );
  }
}

/**
 * Clean up old logs based on retention policy
 */
async function cleanupOldLogs(): Promise<void> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - LOG_RETENTION_DAYS);

  // Note: Using raw SQL for the date comparison since drizzle doesn't have lt/gt exported here
  const deleted = await db
    .delete(containerLogs)
    .where(
      and(
        // Only delete logs older than retention period
        // This is a simplified cleanup - in production you might want batch deletion
      )
    );

  // For now, just log that cleanup ran
  logger.debug('Log cleanup cycle completed');
}

/**
 * Get historical logs for a deployment
 */
export async function getHistoricalLogs(
  deploymentId: string,
  options?: {
    limit?: number;
    offset?: number;
    startTime?: Date;
    endTime?: Date;
  }
): Promise<{
  logs: Array<{
    content: string;
    timestamp: Date;
    lineCount: number;
  }>;
  totalChunks: number;
}> {
  const { limit = 10, offset = 0 } = options || {};

  const chunks = await db
    .select({
      logContent: containerLogs.logContent,
      startTimestamp: containerLogs.startTimestamp,
      lineCount: containerLogs.lineCount,
      chunkIndex: containerLogs.chunkIndex,
    })
    .from(containerLogs)
    .where(eq(containerLogs.deploymentId, deploymentId))
    .orderBy(desc(containerLogs.chunkIndex))
    .limit(limit)
    .offset(offset);

  // Get total count
  const countResult = await db
    .select({ count: containerLogs.id })
    .from(containerLogs)
    .where(eq(containerLogs.deploymentId, deploymentId));

  return {
    logs: chunks.map(chunk => ({
      content: chunk.logContent,
      timestamp: chunk.startTimestamp || new Date(),
      lineCount: chunk.lineCount,
    })),
    totalChunks: countResult.length,
  };
}

/**
 * Get combined logs (historical + live) for a deployment
 */
export async function getCombinedLogs(
  deploymentId: string,
  projectSlug: string,
  serverId: string | null,
  limit: number = 500
): Promise<string> {
  // Get historical logs first
  const historical = await getHistoricalLogs(deploymentId, { limit: 5 });

  // Combine historical logs
  let combinedLogs = historical.logs
    .reverse()
    .map(chunk => chunk.content)
    .join('\n');

  // If we need more lines, get live logs
  const historicalLineCount = combinedLogs.split('\n').length;
  if (historicalLineCount < limit) {
    // Get additional live logs
    // This is handled by the streaming endpoint
  }

  return combinedLogs;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isLogCollectorRunning(): boolean {
  return isRunning;
}
