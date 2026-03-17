import { db } from '../db';
import { activityLogs, type ActivityAction, type NewActivityLog } from '../db/schema/activity';
import { users } from '../db/schema/users';
import { projects } from '../db/schema/projects';
import { eq, desc, and, or, inArray, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';

export interface ActivityLogInput {
  organizationId: string;
  userId?: string;
  projectId?: string;
  action: ActivityAction;
  description: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export interface ActivityLogFilters {
  projectId?: string;
  userId?: string;
  actions?: ActivityAction[];
  limit?: number;
  offset?: number;
}

export interface ActivityLogWithDetails {
  id: string;
  action: ActivityAction;
  description: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  user: {
    id: string;
    name: string | null;
    email: string;
    avatarUrl: string | null;
  } | null;
  project: {
    id: string;
    name: string;
    slug: string;
  } | null;
}

class ActivityService {
  /**
   * Log an activity
   */
  async log(input: ActivityLogInput): Promise<void> {
    try {
      await db.insert(activityLogs).values({
        organizationId: input.organizationId,
        userId: input.userId,
        projectId: input.projectId,
        action: input.action,
        description: input.description,
        metadata: input.metadata || {},
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });

      logger.debug({ action: input.action, description: input.description }, 'Activity logged');
    } catch (error) {
      // Don't throw - activity logging should not break the main flow
      logger.error({ error, input }, 'Failed to log activity');
    }
  }

  /**
   * Get activity logs for an organization
   */
  async getByOrganization(
    organizationId: string,
    filters: ActivityLogFilters = {}
  ): Promise<{ logs: ActivityLogWithDetails[]; total: number }> {
    const { projectId, userId, actions, limit = 50, offset = 0 } = filters;

    // Build where conditions
    const conditions = [eq(activityLogs.organizationId, organizationId)];

    if (projectId) {
      conditions.push(eq(activityLogs.projectId, projectId));
    }

    if (userId) {
      conditions.push(eq(activityLogs.userId, userId));
    }

    if (actions && actions.length > 0) {
      conditions.push(inArray(activityLogs.action, actions));
    }

    const whereClause = and(...conditions);

    // Get total count
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(activityLogs)
      .where(whereClause);

    // Get logs with user and project details
    const logs = await db
      .select({
        id: activityLogs.id,
        action: activityLogs.action,
        description: activityLogs.description,
        metadata: activityLogs.metadata,
        createdAt: activityLogs.createdAt,
        userId: activityLogs.userId,
        projectId: activityLogs.projectId,
        userName: users.name,
        userEmail: users.email,
        userAvatarUrl: users.avatarUrl,
        projectName: projects.name,
        projectSlug: projects.slug,
      })
      .from(activityLogs)
      .leftJoin(users, eq(activityLogs.userId, users.id))
      .leftJoin(projects, eq(activityLogs.projectId, projects.id))
      .where(whereClause)
      .orderBy(desc(activityLogs.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      logs: logs.map((log) => ({
        id: log.id,
        action: log.action,
        description: log.description,
        metadata: log.metadata as Record<string, unknown>,
        createdAt: log.createdAt,
        user: log.userId
          ? {
              id: log.userId,
              name: log.userName,
              email: log.userEmail!,
              avatarUrl: log.userAvatarUrl,
            }
          : null,
        project: log.projectId
          ? {
              id: log.projectId,
              name: log.projectName!,
              slug: log.projectSlug!,
            }
          : null,
      })),
      total: count,
    };
  }

  /**
   * Get activity logs for a specific project
   */
  async getByProject(
    projectId: string,
    organizationId: string,
    filters: Omit<ActivityLogFilters, 'projectId'> = {}
  ): Promise<{ logs: ActivityLogWithDetails[]; total: number }> {
    return this.getByOrganization(organizationId, { ...filters, projectId });
  }

  // ============ Helper methods for common actions ============

  async logProjectCreated(
    organizationId: string,
    userId: string,
    projectId: string,
    projectName: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      projectId,
      action: 'project.created',
      description: `Created project "${projectName}"`,
      metadata: { projectName },
      ipAddress,
      userAgent,
    });
  }

  async logProjectUpdated(
    organizationId: string,
    userId: string,
    projectId: string,
    projectName: string,
    changes: Record<string, unknown>,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    const changedFields = Object.keys(changes).join(', ');
    await this.log({
      organizationId,
      userId,
      projectId,
      action: 'project.updated',
      description: `Updated project "${projectName}" (${changedFields})`,
      metadata: { projectName, changes },
      ipAddress,
      userAgent,
    });
  }

  async logProjectDeleted(
    organizationId: string,
    userId: string,
    projectId: string,
    projectName: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      projectId,
      action: 'project.deleted',
      description: `Deleted project "${projectName}"`,
      metadata: { projectName },
      ipAddress,
      userAgent,
    });
  }

  async logDeploymentCreated(
    organizationId: string,
    userId: string | undefined,
    projectId: string,
    deploymentId: string,
    branch?: string,
    trigger?: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      projectId,
      action: 'deployment.created',
      description: `Triggered deployment${branch ? ` from branch "${branch}"` : ''}`,
      metadata: { deploymentId, branch, trigger },
      ipAddress,
      userAgent,
    });
  }

  async logDeploymentSucceeded(
    organizationId: string,
    projectId: string,
    deploymentId: string
  ): Promise<void> {
    await this.log({
      organizationId,
      projectId,
      action: 'deployment.succeeded',
      description: 'Deployment completed successfully',
      metadata: { deploymentId },
    });
  }

  async logDeploymentFailed(
    organizationId: string,
    projectId: string,
    deploymentId: string,
    error?: string
  ): Promise<void> {
    await this.log({
      organizationId,
      projectId,
      action: 'deployment.failed',
      description: 'Deployment failed',
      metadata: { deploymentId, error },
    });
  }

  async logEnvVarCreated(
    organizationId: string,
    userId: string,
    projectId: string,
    key: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      projectId,
      action: 'envvar.created',
      description: `Added environment variable "${key}"`,
      metadata: { key },
      ipAddress,
      userAgent,
    });
  }

  async logEnvVarDeleted(
    organizationId: string,
    userId: string,
    projectId: string,
    key: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      projectId,
      action: 'envvar.deleted',
      description: `Deleted environment variable "${key}"`,
      metadata: { key },
      ipAddress,
      userAgent,
    });
  }

  async logDomainAdded(
    organizationId: string,
    userId: string,
    projectId: string,
    domain: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      projectId,
      action: 'domain.added',
      description: `Added domain "${domain}"`,
      metadata: { domain },
      ipAddress,
      userAgent,
    });
  }

  async logDomainRemoved(
    organizationId: string,
    userId: string,
    projectId: string,
    domain: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      projectId,
      action: 'domain.removed',
      description: `Removed domain "${domain}"`,
      metadata: { domain },
      ipAddress,
      userAgent,
    });
  }

  async logApiKeyCreated(
    organizationId: string,
    userId: string,
    keyName: string,
    keyPrefix: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      action: 'apikey.created',
      description: `Created API key "${keyName}"`,
      metadata: { keyName, keyPrefix },
      ipAddress,
      userAgent,
    });
  }

  async logApiKeyRevoked(
    organizationId: string,
    userId: string,
    keyName: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      action: 'apikey.revoked',
      description: `Revoked API key "${keyName}"`,
      metadata: { keyName },
      ipAddress,
      userAgent,
    });
  }

  async logSettingsUpdated(
    organizationId: string,
    userId: string,
    projectId: string,
    setting: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      projectId,
      action: 'settings.updated',
      description: `Updated ${setting}`,
      metadata: { setting },
      ipAddress,
      userAgent,
    });
  }
}

export const activityService = new ActivityService();
