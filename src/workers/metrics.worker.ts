import { metricsService } from '../services/metrics.service';
import { metricsRepository } from '../repositories/metrics.repository';
import { execCommand } from './shell';
import { logger } from '../lib/logger';
import { wsManager } from '../lib/ws';
import type { NewContainerMetric } from '../db/schema';

const POLL_INTERVAL = 15000; // 15 seconds
const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

let isRunning = false;
let lastCleanup = Date.now();

/**
 * Parse docker stats output (JSON format)
 */
interface DockerStatsOutput {
  Container: string;
  Name: string;
  ID: string;
  CPUPerc: string;
  MemUsage: string;
  MemPerc: string;
  NetIO: string;
  BlockIO: string;
  PIDs: string;
}

/**
 * Start the metrics worker
 */
export async function startMetricsWorker(): Promise<void> {
  if (isRunning) {
    logger.warn('Metrics worker is already running');
    return;
  }

  isRunning = true;
  logger.info('📊 Metrics worker started');

  // Start polling
  pollForMetrics();
}

/**
 * Stop the metrics worker
 */
export function stopMetricsWorker(): void {
  isRunning = false;
  logger.info('Metrics worker stopped');
}

/**
 * Poll for container metrics
 */
async function pollForMetrics(): Promise<void> {
  while (isRunning) {
    try {
      // Get all projects with running containers
      const projectsToMonitor = await metricsService.getProjectsForMetricsCollection();

      if (projectsToMonitor.length > 0) {
        // Collect container names
        const containerNames = projectsToMonitor.map((p) => p.containerName);

        // Get stats for all containers in one call
        const stats = await getDockerStats(containerNames);

        // Create metrics records
        const metricsToInsert: NewContainerMetric[] = [];

        for (const project of projectsToMonitor) {
          const stat = stats.get(project.containerName);

          if (stat) {
            metricsToInsert.push({
              projectId: project.projectId,
              deploymentId: project.deploymentId,
              containerName: project.containerName,
              cpuPercent: stat.cpuPercent,
              memoryUsageBytes: stat.memoryUsageBytes,
              memoryLimitBytes: stat.memoryLimitBytes,
              memoryPercent: stat.memoryPercent,
              networkRxBytes: stat.networkRxBytes,
              networkTxBytes: stat.networkTxBytes,
              blockReadBytes: stat.blockReadBytes,
              blockWriteBytes: stat.blockWriteBytes,
              containerStatus: stat.status,
              pids: stat.pids,
            });
          }
        }

        // Bulk insert metrics
        if (metricsToInsert.length > 0) {
          await metricsService.recordBulkMetrics(metricsToInsert);
          logger.debug({ count: metricsToInsert.length }, 'Metrics recorded');

          // Publish metrics via WebSocket per project
          for (const metric of metricsToInsert) {
            wsManager.publish(`project:${metric.projectId}`, {
              type: 'metrics:update',
              data: {
                projectId: metric.projectId,
                cpuPercent: metric.cpuPercent,
                memoryPercent: metric.memoryPercent,
                memoryUsageBytes: metric.memoryUsageBytes,
                memoryLimitBytes: metric.memoryLimitBytes,
                networkRxBytes: metric.networkRxBytes,
                networkTxBytes: metric.networkTxBytes,
              },
            }).catch(() => {});
          }
        }
      }

      // Periodic cleanup
      if (Date.now() - lastCleanup > CLEANUP_INTERVAL) {
        const deleted = await metricsRepository.cleanAllOldMetrics(7);
        logger.info({ deleted }, 'Old metrics cleaned up');
        lastCleanup = Date.now();
      }
    } catch (error) {
      logger.error({ err: error }, 'Error polling for metrics');
    }

    await sleep(POLL_INTERVAL);
  }
}

/**
 * Get docker stats for specified containers
 */
async function getDockerStats(
  containerNames: string[]
): Promise<
  Map<
    string,
    {
      cpuPercent: number;
      memoryUsageBytes: number;
      memoryLimitBytes: number;
      memoryPercent: number;
      networkRxBytes: number;
      networkTxBytes: number;
      blockReadBytes: number;
      blockWriteBytes: number;
      status: string;
      pids: number;
    }
  >
> {
  const result = new Map<
    string,
    {
      cpuPercent: number;
      memoryUsageBytes: number;
      memoryLimitBytes: number;
      memoryPercent: number;
      networkRxBytes: number;
      networkTxBytes: number;
      blockReadBytes: number;
      blockWriteBytes: number;
      status: string;
      pids: number;
    }
  >();

  if (containerNames.length === 0) {
    return result;
  }

  try {
    // Use docker stats with --no-stream for a single snapshot
    const containerList = containerNames.join(' ');
    const { stdout, exitCode } = await execCommand(
      `docker stats --no-stream --format '{{json .}}' ${containerList}`,
      { timeout: 10000 }
    );

    if (exitCode !== 0 || !stdout.trim()) {
      return result;
    }

    // Parse each line as JSON
    const lines = stdout.trim().split('\n');

    for (const line of lines) {
      try {
        const stats: DockerStatsOutput = JSON.parse(line);
        const name = stats.Name;

        result.set(name, {
          cpuPercent: parsePercent(stats.CPUPerc),
          memoryUsageBytes: parseMemoryUsage(stats.MemUsage),
          memoryLimitBytes: parseMemoryLimit(stats.MemUsage),
          memoryPercent: parsePercent(stats.MemPerc),
          networkRxBytes: parseNetworkRx(stats.NetIO),
          networkTxBytes: parseNetworkTx(stats.NetIO),
          blockReadBytes: parseBlockRead(stats.BlockIO),
          blockWriteBytes: parseBlockWrite(stats.BlockIO),
          status: 'running',
          pids: parseInt(stats.PIDs) || 0,
        });
      } catch {
        // Skip invalid JSON lines
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'Error getting docker stats');
  }

  return result;
}

/**
 * Parse percentage string (e.g., "12.34%") to number
 */
function parsePercent(str: string): number {
  const match = str.match(/([\d.]+)%/);
  return match ? parseFloat(match[1]) : 0;
}

/**
 * Parse memory usage from string (e.g., "123.4MiB / 1GiB")
 */
function parseMemoryUsage(str: string): number {
  const parts = str.split('/');
  if (parts.length < 1) return 0;
  return parseSize(parts[0].trim());
}

/**
 * Parse memory limit from string (e.g., "123.4MiB / 1GiB")
 */
function parseMemoryLimit(str: string): number {
  const parts = str.split('/');
  if (parts.length < 2) return 0;
  return parseSize(parts[1].trim());
}

/**
 * Parse network RX bytes (e.g., "1.23MB / 4.56MB")
 */
function parseNetworkRx(str: string): number {
  const parts = str.split('/');
  if (parts.length < 1) return 0;
  return parseSize(parts[0].trim());
}

/**
 * Parse network TX bytes (e.g., "1.23MB / 4.56MB")
 */
function parseNetworkTx(str: string): number {
  const parts = str.split('/');
  if (parts.length < 2) return 0;
  return parseSize(parts[1].trim());
}

/**
 * Parse block read bytes (e.g., "1.23MB / 4.56MB")
 */
function parseBlockRead(str: string): number {
  const parts = str.split('/');
  if (parts.length < 1) return 0;
  return parseSize(parts[0].trim());
}

/**
 * Parse block write bytes (e.g., "1.23MB / 4.56MB")
 */
function parseBlockWrite(str: string): number {
  const parts = str.split('/');
  if (parts.length < 2) return 0;
  return parseSize(parts[1].trim());
}

/**
 * Parse size string (e.g., "123.4MiB", "1.5GiB", "500B") to bytes
 */
function parseSize(str: string): number {
  const match = str.match(/([\d.]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)?/i);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();

  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1000,
    MB: 1000 * 1000,
    GB: 1000 * 1000 * 1000,
    TB: 1000 * 1000 * 1000 * 1000,
    KIB: 1024,
    MIB: 1024 * 1024,
    GIB: 1024 * 1024 * 1024,
    TIB: 1024 * 1024 * 1024 * 1024,
  };

  return Math.round(value * (multipliers[unit] || 1));
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
export function isMetricsWorkerRunning(): boolean {
  return isRunning;
}
