import { metricsRepository } from '../repositories/metrics.repository';
import { deploymentRepository } from '../repositories/deployment.repository';
import type { ContainerMetric, NewContainerMetric } from '../db/schema';

export interface MetricsSummary {
  current: {
    cpuPercent: number;
    memoryPercent: number;
    memoryUsageMB: number;
    memoryLimitMB: number;
    networkRxMB: number;
    networkTxMB: number;
    containerStatus: string;
    recordedAt: Date;
  } | null;
  stats24h: {
    avgCpu: number;
    maxCpu: number;
    avgMemory: number;
    maxMemory: number;
    totalNetworkRxMB: number;
    totalNetworkTxMB: number;
    dataPoints: number;
  } | null;
}

export interface TimeSeriesDataPoint {
  timestamp: Date;
  cpuPercent: number;
  memoryPercent: number;
  memoryUsageMB: number;
  networkRxMB: number;
  networkTxMB: number;
}

export interface ProjectMetricSnapshot {
  projectId: string;
  projectName: string;
  projectSlug: string;
  cpuPercent: number;
  memoryPercent: number;
  memoryUsageMB: number;
  memoryLimitMB: number;
  networkRxMB: number;
  networkTxMB: number;
  containerStatus: string;
  recordedAt: Date;
}

export interface MetricsOverview {
  totalProjects: number;
  runningContainers: number;
  aggregate: {
    totalCpuPercent: number;
    totalMemoryUsageMB: number;
    totalMemoryLimitMB: number;
    totalNetworkRxMB: number;
    totalNetworkTxMB: number;
    avgCpuPercent: number;
    avgMemoryPercent: number;
  };
  projects: ProjectMetricSnapshot[];
}

const bytesToMB = (bytes: number): number => Math.round((bytes / (1024 * 1024)) * 100) / 100;

export const metricsService = {
  // Record metrics for a container
  async recordMetrics(data: NewContainerMetric): Promise<ContainerMetric> {
    return metricsRepository.create(data);
  },

  // Bulk record metrics
  async recordBulkMetrics(data: NewContainerMetric[]): Promise<void> {
    return metricsRepository.createMany(data);
  },

  // Get metrics summary for a project
  async getMetricsSummary(projectId: string): Promise<MetricsSummary> {
    const [latest, stats24h] = await Promise.all([
      metricsRepository.findLatestByProject(projectId),
      metricsRepository.getAggregatedStats(projectId, 24),
    ]);

    return {
      current: latest
        ? {
            cpuPercent: latest.cpuPercent,
            memoryPercent: latest.memoryPercent,
            memoryUsageMB: bytesToMB(latest.memoryUsageBytes),
            memoryLimitMB: bytesToMB(latest.memoryLimitBytes),
            networkRxMB: bytesToMB(latest.networkRxBytes),
            networkTxMB: bytesToMB(latest.networkTxBytes),
            containerStatus: latest.containerStatus,
            recordedAt: latest.recordedAt,
          }
        : null,
      stats24h: stats24h
        ? {
            avgCpu: Math.round(stats24h.avgCpu * 100) / 100,
            maxCpu: Math.round(stats24h.maxCpu * 100) / 100,
            avgMemory: Math.round(stats24h.avgMemory * 100) / 100,
            maxMemory: Math.round(stats24h.maxMemory * 100) / 100,
            totalNetworkRxMB: bytesToMB(stats24h.totalNetworkRx),
            totalNetworkTxMB: bytesToMB(stats24h.totalNetworkTx),
            dataPoints: stats24h.dataPoints,
          }
        : null,
    };
  },

  // Get time series data for charts
  async getTimeSeriesData(
    projectId: string,
    hours = 1
  ): Promise<TimeSeriesDataPoint[]> {
    const metrics = await metricsRepository.findRecentByProject(projectId, hours);

    return metrics.map((m) => ({
      timestamp: m.recordedAt,
      cpuPercent: m.cpuPercent,
      memoryPercent: m.memoryPercent,
      memoryUsageMB: bytesToMB(m.memoryUsageBytes),
      networkRxMB: bytesToMB(m.networkRxBytes),
      networkTxMB: bytesToMB(m.networkTxBytes),
    }));
  },

  // Get all projects with running containers for metrics collection
  async getProjectsForMetricsCollection(): Promise<
    Array<{
      projectId: string;
      containerName: string;
      deploymentId: string | null;
      slug: string;
    }>
  > {
    // Get all projects with running deployments
    const projectsWithRunningDeployments =
      await deploymentRepository.findProjectsWithRunningDeployments();

    return projectsWithRunningDeployments.map((item) => ({
      projectId: item.projectId,
      containerName: `pushify-${item.slug}`,
      deploymentId: item.deploymentId,
      slug: item.slug,
    }));
  },

  // Get metrics overview for all projects in an organization
  async getMetricsOverview(organizationId: string): Promise<MetricsOverview> {
    const latestMetrics = await metricsRepository.findLatestByOrganization(organizationId);

    const projectSnapshots: ProjectMetricSnapshot[] = latestMetrics.map((m) => ({
      projectId: m.projectId,
      projectName: m.projectName,
      projectSlug: m.projectSlug,
      cpuPercent: Math.round(Number(m.cpuPercent) * 100) / 100,
      memoryPercent: Math.round(Number(m.memoryPercent) * 100) / 100,
      memoryUsageMB: bytesToMB(Number(m.memoryUsageBytes)),
      memoryLimitMB: bytesToMB(Number(m.memoryLimitBytes)),
      networkRxMB: bytesToMB(Number(m.networkRxBytes)),
      networkTxMB: bytesToMB(Number(m.networkTxBytes)),
      containerStatus: m.containerStatus,
      recordedAt: new Date(m.recordedAt),
    }));

    const runningContainers = projectSnapshots.filter(
      (p) => p.containerStatus === 'running'
    ).length;

    const totalCpu = projectSnapshots.reduce((sum, p) => sum + p.cpuPercent, 0);
    const totalMemUsage = projectSnapshots.reduce((sum, p) => sum + p.memoryUsageMB, 0);
    const totalMemLimit = projectSnapshots.reduce((sum, p) => sum + p.memoryLimitMB, 0);
    const totalNetRx = projectSnapshots.reduce((sum, p) => sum + p.networkRxMB, 0);
    const totalNetTx = projectSnapshots.reduce((sum, p) => sum + p.networkTxMB, 0);
    const count = projectSnapshots.length || 1;

    return {
      totalProjects: projectSnapshots.length,
      runningContainers,
      aggregate: {
        totalCpuPercent: Math.round(totalCpu * 100) / 100,
        totalMemoryUsageMB: Math.round(totalMemUsage * 100) / 100,
        totalMemoryLimitMB: Math.round(totalMemLimit * 100) / 100,
        totalNetworkRxMB: Math.round(totalNetRx * 100) / 100,
        totalNetworkTxMB: Math.round(totalNetTx * 100) / 100,
        avgCpuPercent: Math.round((totalCpu / count) * 100) / 100,
        avgMemoryPercent:
          Math.round(
            (projectSnapshots.reduce((sum, p) => sum + p.memoryPercent, 0) / count) * 100
          ) / 100,
      },
      projects: projectSnapshots,
    };
  },

  // Clean old metrics
  async cleanOldMetrics(daysToKeep = 7): Promise<number> {
    return metricsRepository.cleanAllOldMetrics(daysToKeep);
  },
};
