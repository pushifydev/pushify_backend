import { eq, desc, and, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  containerMetrics,
  type ContainerMetric,
  type NewContainerMetric,
} from '../db/schema';
import { projects } from '../db/schema/projects';

export const metricsRepository = {
  // Create a new metrics record
  async create(data: NewContainerMetric): Promise<ContainerMetric> {
    const [metric] = await db.insert(containerMetrics).values(data).returning();
    return metric;
  },

  // Bulk insert metrics
  async createMany(data: NewContainerMetric[]): Promise<void> {
    if (data.length === 0) return;
    await db.insert(containerMetrics).values(data);
  },

  // Get latest metrics for a project
  async findLatestByProject(projectId: string): Promise<ContainerMetric | undefined> {
    return db.query.containerMetrics.findFirst({
      where: eq(containerMetrics.projectId, projectId),
      orderBy: [desc(containerMetrics.recordedAt)],
    });
  },

  // Get metrics history for a project within a time range
  async findByProjectInRange(
    projectId: string,
    startTime: Date,
    endTime: Date,
    limit = 1000
  ): Promise<ContainerMetric[]> {
    return db.query.containerMetrics.findMany({
      where: and(
        eq(containerMetrics.projectId, projectId),
        gte(containerMetrics.recordedAt, startTime),
        lte(containerMetrics.recordedAt, endTime)
      ),
      orderBy: [desc(containerMetrics.recordedAt)],
      limit,
    });
  },

  // Get metrics for the last N hours
  async findRecentByProject(projectId: string, hours = 1): Promise<ContainerMetric[]> {
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    return db.query.containerMetrics.findMany({
      where: and(
        eq(containerMetrics.projectId, projectId),
        gte(containerMetrics.recordedAt, startTime)
      ),
      orderBy: [desc(containerMetrics.recordedAt)],
    });
  },

  // Get aggregated stats for a project (average over time period)
  async getAggregatedStats(
    projectId: string,
    hours = 24
  ): Promise<{
    avgCpu: number;
    maxCpu: number;
    avgMemory: number;
    maxMemory: number;
    totalNetworkRx: number;
    totalNetworkTx: number;
    dataPoints: number;
  } | null> {
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);

    const result = await db
      .select({
        avgCpu: sql<number>`AVG(${containerMetrics.cpuPercent})`,
        maxCpu: sql<number>`MAX(${containerMetrics.cpuPercent})`,
        avgMemory: sql<number>`AVG(${containerMetrics.memoryPercent})`,
        maxMemory: sql<number>`MAX(${containerMetrics.memoryPercent})`,
        totalNetworkRx: sql<number>`MAX(${containerMetrics.networkRxBytes})`,
        totalNetworkTx: sql<number>`MAX(${containerMetrics.networkTxBytes})`,
        dataPoints: sql<number>`COUNT(*)`,
      })
      .from(containerMetrics)
      .where(
        and(
          eq(containerMetrics.projectId, projectId),
          gte(containerMetrics.recordedAt, startTime)
        )
      );

    if (!result[0] || result[0].dataPoints === 0) {
      return null;
    }

    return {
      avgCpu: Number(result[0].avgCpu) || 0,
      maxCpu: Number(result[0].maxCpu) || 0,
      avgMemory: Number(result[0].avgMemory) || 0,
      maxMemory: Number(result[0].maxMemory) || 0,
      totalNetworkRx: Number(result[0].totalNetworkRx) || 0,
      totalNetworkTx: Number(result[0].totalNetworkTx) || 0,
      dataPoints: Number(result[0].dataPoints) || 0,
    };
  },

  // Clean old metrics (default: keep last 7 days)
  async cleanOldMetrics(projectId: string, daysToKeep = 7): Promise<number> {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

    const result = await db
      .delete(containerMetrics)
      .where(
        and(
          eq(containerMetrics.projectId, projectId),
          lte(containerMetrics.recordedAt, cutoffDate)
        )
      )
      .returning({ id: containerMetrics.id });

    return result.length;
  },

  // Clean all old metrics across all projects
  async cleanAllOldMetrics(daysToKeep = 7): Promise<number> {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

    const result = await db
      .delete(containerMetrics)
      .where(lte(containerMetrics.recordedAt, cutoffDate))
      .returning({ id: containerMetrics.id });

    return result.length;
  },

  // Delete all metrics for a project
  async deleteByProject(projectId: string): Promise<void> {
    await db.delete(containerMetrics).where(eq(containerMetrics.projectId, projectId));
  },

  // Get latest metrics for all projects in an organization
  async findLatestByOrganization(organizationId: string): Promise<
    Array<{
      projectId: string;
      projectName: string;
      projectSlug: string;
      cpuPercent: number;
      memoryUsageBytes: number;
      memoryLimitBytes: number;
      memoryPercent: number;
      networkRxBytes: number;
      networkTxBytes: number;
      containerStatus: string;
      recordedAt: Date;
    }>
  > {
    const result = await db.execute(sql`
      SELECT DISTINCT ON (cm.project_id)
        cm.project_id AS "projectId",
        p.name AS "projectName",
        p.slug AS "projectSlug",
        cm.cpu_percent AS "cpuPercent",
        cm.memory_usage_bytes AS "memoryUsageBytes",
        cm.memory_limit_bytes AS "memoryLimitBytes",
        cm.memory_percent AS "memoryPercent",
        cm.network_rx_bytes AS "networkRxBytes",
        cm.network_tx_bytes AS "networkTxBytes",
        cm.container_status AS "containerStatus",
        cm.recorded_at AS "recordedAt"
      FROM container_metrics cm
      JOIN projects p ON p.id = cm.project_id
      WHERE p.organization_id = ${organizationId}
        AND cm.recorded_at > NOW() - INTERVAL '5 minutes'
      ORDER BY cm.project_id, cm.recorded_at DESC
    `);

    return (result.rows || []) as Array<{
      projectId: string;
      projectName: string;
      projectSlug: string;
      cpuPercent: number;
      memoryUsageBytes: number;
      memoryLimitBytes: number;
      memoryPercent: number;
      networkRxBytes: number;
      networkTxBytes: number;
      containerStatus: string;
      recordedAt: Date;
    }>;
  },
};
