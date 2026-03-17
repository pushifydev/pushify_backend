import { eq, desc, and, lte } from 'drizzle-orm';
import { db } from '../db';
import {
  healthChecks,
  healthCheckLogs,
  type HealthCheck,
  type NewHealthCheck,
  type HealthCheckLog,
  type NewHealthCheckLog,
} from '../db/schema';

export const healthCheckRepository = {
  // ============ Health Check Config ============

  // Find health check config by project ID
  async findByProjectId(projectId: string): Promise<HealthCheck | undefined> {
    return db.query.healthChecks.findFirst({
      where: eq(healthChecks.projectId, projectId),
    });
  },

  // Find all active health checks that are due to be checked
  async findActiveHealthChecks(): Promise<HealthCheck[]> {
    return db.query.healthChecks.findMany({
      where: eq(healthChecks.isActive, true),
    });
  },

  // Create health check config
  async create(data: NewHealthCheck): Promise<HealthCheck> {
    const [healthCheck] = await db
      .insert(healthChecks)
      .values(data)
      .returning();

    return healthCheck;
  },

  // Update health check config
  async update(
    projectId: string,
    data: Partial<Omit<NewHealthCheck, 'id' | 'projectId'>>
  ): Promise<HealthCheck | undefined> {
    const [healthCheck] = await db
      .update(healthChecks)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(healthChecks.projectId, projectId))
      .returning();

    return healthCheck;
  },

  // Delete health check config
  async delete(projectId: string): Promise<void> {
    await db.delete(healthChecks).where(eq(healthChecks.projectId, projectId));
  },

  // ============ Health Check Logs ============

  // Find logs by project
  async findLogsByProject(projectId: string, limit = 50): Promise<HealthCheckLog[]> {
    return db.query.healthCheckLogs.findMany({
      where: eq(healthCheckLogs.projectId, projectId),
      orderBy: [desc(healthCheckLogs.checkedAt)],
      limit,
    });
  },

  // Find latest log for project
  async findLatestLog(projectId: string): Promise<HealthCheckLog | undefined> {
    return db.query.healthCheckLogs.findFirst({
      where: eq(healthCheckLogs.projectId, projectId),
      orderBy: [desc(healthCheckLogs.checkedAt)],
    });
  },

  // Create log
  async createLog(data: NewHealthCheckLog): Promise<HealthCheckLog> {
    const [log] = await db
      .insert(healthCheckLogs)
      .values(data)
      .returning();

    return log;
  },

  // Count consecutive failures for a project
  async getConsecutiveFailures(projectId: string): Promise<number> {
    const latestLog = await this.findLatestLog(projectId);
    return latestLog?.consecutiveFailures ?? 0;
  },

  // Clean old logs (keep last 100 per project)
  async cleanOldLogs(projectId: string, keepCount = 100): Promise<void> {
    // Get the IDs of logs to keep
    const logsToKeep = await db
      .select({ id: healthCheckLogs.id })
      .from(healthCheckLogs)
      .where(eq(healthCheckLogs.projectId, projectId))
      .orderBy(desc(healthCheckLogs.checkedAt))
      .limit(keepCount);

    const keepIds = logsToKeep.map((l) => l.id);

    if (keepIds.length === keepCount) {
      // Delete logs older than the oldest one to keep
      const oldestToKeep = await db
        .select({ checkedAt: healthCheckLogs.checkedAt })
        .from(healthCheckLogs)
        .where(eq(healthCheckLogs.projectId, projectId))
        .orderBy(desc(healthCheckLogs.checkedAt))
        .limit(1)
        .offset(keepCount - 1);

      if (oldestToKeep[0]) {
        await db
          .delete(healthCheckLogs)
          .where(
            and(
              eq(healthCheckLogs.projectId, projectId),
              lte(healthCheckLogs.checkedAt, oldestToKeep[0].checkedAt)
            )
          );
      }
    }
  },
};
