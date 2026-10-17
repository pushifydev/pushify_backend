import { db } from '../db';
import { activityLogs, type ActivityAction } from '../db/schema/activity';
import { users } from '../db/schema/users';
import { projects } from '../db/schema/projects';
import { eq, desc, and, inArray, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { normalizeClientIp } from '../lib/utils';
import { currentAuditApiKey, sanitizeChanges, type AuditChanges, type AuditSource } from '../lib/audit';

export interface ActivityLogInput {
  organizationId: string;
  userId?: string;
  projectId?: string;
  action: ActivityAction;
  description: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  /** ui | api | webhook | system. Defaults to `system` when there is no acting user. */
  source?: AuditSource;
  /** Field-level before/after diff (build it with `diffChanges`; secrets are `{ changed: true }`). */
  changes?: AuditChanges;
}

export interface ActivityLogFilters {
  projectId?: string;
  userId?: string;
  actions?: ActivityAction[];
  /** Only entries from these sources (ui | api | webhook | system) */
  sources?: AuditSource[];
  limit?: number;
  offset?: number;
}

export interface ActivityLogWithDetails {
  id: string;
  action: ActivityAction;
  description: string;
  metadata: Record<string, unknown>;
  /** ui | api | webhook | system; null for entries recorded before the source was tracked */
  source: AuditSource | null;
  /** Field-level before/after diff, null when the action has none */
  changes: AuditChanges | null;
  createdAt: Date;
  /** Where the action came from — what a compliance review asks for */
  ipAddress: string | null;
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
      // API key callers: name the key that acted (id + name only, never the secret).
      const metadata: Record<string, unknown> = { ...(input.metadata || {}) };
      const apiKey = input.source === 'api' ? currentAuditApiKey() : undefined;
      if (apiKey && metadata.apiKey === undefined) {
        metadata.apiKey = { id: apiKey.id, name: apiKey.name };
      }

      await db.insert(activityLogs).values({
        organizationId: input.organizationId,
        userId: input.userId,
        projectId: input.projectId,
        action: input.action,
        description: input.description,
        metadata,
        source: input.source ?? (input.userId ? null : 'system'),
        // Defence in depth: whatever a caller passes, sensitive keys and URL credentials are stripped.
        changes: sanitizeChanges(input.changes),
        ipAddress: normalizeClientIp(input.ipAddress),
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
    const { projectId, userId, actions, sources, limit = 50, offset = 0 } = filters;

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

    if (sources && sources.length > 0) {
      conditions.push(inArray(activityLogs.source, sources));
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
        source: activityLogs.source,
        changes: activityLogs.changes,
        createdAt: activityLogs.createdAt,
        ipAddress: activityLogs.ipAddress,
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
        source: (log.source as AuditSource | null) ?? null,
        changes: (log.changes as AuditChanges | null) ?? null,
        createdAt: log.createdAt,
        ipAddress: log.ipAddress,
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
    userAgent?: string,
    source?: AuditSource
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
      source,
    });
  }

  async logProjectUpdated(
    organizationId: string,
    userId: string,
    projectId: string,
    projectName: string,
    changes: AuditChanges,
    ipAddress?: string,
    userAgent?: string,
    source?: AuditSource
  ): Promise<void> {
    const fields = Object.keys(changes);
    await this.log({
      organizationId,
      userId,
      projectId,
      action: 'project.updated',
      description: `Updated project "${projectName}"${fields.length ? ` (${fields.join(', ')})` : ''}`,
      metadata: { projectName, fields },
      changes,
      ipAddress,
      userAgent,
      source,
    });
  }

  async logProjectDeleted(
    organizationId: string,
    userId: string,
    projectId: string,
    projectName: string,
    ipAddress?: string,
    userAgent?: string,
    source?: AuditSource
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
      source,
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
    userAgent?: string,
    source?: AuditSource
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
      source,
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
    userAgent?: string,
    source?: AuditSource
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
      source,
    });
  }

  async logEnvVarDeleted(
    organizationId: string,
    userId: string,
    projectId: string,
    key: string,
    ipAddress?: string,
    userAgent?: string,
    source?: AuditSource
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
      source,
    });
  }

  /**
   * An env var changed. The value is never recorded, old or new, secret or not: the audit log is
   * readable by every admin and exported as CSV, and a secret that lands here has leaked. A value
   * change is written as `{ value: { changed: true } }`; the secret flag is a plain from/to.
   */
  async logEnvVarUpdated(
    organizationId: string,
    userId: string,
    projectId: string,
    key: string,
    diff: { valueChanged: boolean; isSecret?: { from: boolean; to: boolean } },
    ipAddress?: string,
    userAgent?: string,
    source?: AuditSource
  ): Promise<void> {
    const changes: AuditChanges = {};
    if (diff.valueChanged) changes.value = { changed: true };
    if (diff.isSecret && diff.isSecret.from !== diff.isSecret.to) {
      changes.isSecret = { from: diff.isSecret.from, to: diff.isSecret.to };
    }
    await this.log({
      organizationId,
      userId,
      projectId,
      action: 'envvar.updated',
      description: `Updated environment variable "${key}"`,
      metadata: { key, changed: Object.keys(changes) },
      changes,
      ipAddress,
      userAgent,
      source,
    });
  }

  async logMemberAdded(
    organizationId: string,
    userId: string,
    targetUserId: string,
    email: string,
    role: string,
    ipAddress?: string,
    userAgent?: string,
    source?: AuditSource
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      action: 'member.invited',
      description: `Added member "${email}" as ${role}`,
      metadata: { targetUserId, email, role },
      ipAddress,
      userAgent,
      source,
    });
  }

  async logMemberRoleChanged(
    organizationId: string,
    userId: string,
    targetUserId: string,
    fromRole: string | undefined,
    toRole: string,
    ipAddress?: string,
    userAgent?: string,
    source?: AuditSource
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      action: 'member.role_changed',
      description: `Changed member role${fromRole ? ` from ${fromRole}` : ''} to ${toRole}`,
      metadata: { targetUserId, changes: { role: { from: fromRole ?? null, to: toRole } } },
      changes: { role: { from: fromRole ?? null, to: toRole } },
      ipAddress,
      userAgent,
      source,
    });
  }

  async logMemberRemoved(
    organizationId: string,
    userId: string,
    targetUserId: string,
    role: string | undefined,
    ipAddress?: string,
    userAgent?: string,
    source?: AuditSource
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      action: 'member.removed',
      description: 'Removed member',
      metadata: { targetUserId, role: role ?? null },
      ipAddress,
      userAgent,
      source,
    });
  }

  async logDomainAdded(
    organizationId: string,
    userId: string,
    projectId: string,
    domain: string,
    ipAddress?: string,
    userAgent?: string,
    source?: AuditSource
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
      source,
    });
  }

  async logDomainRemoved(
    organizationId: string,
    userId: string,
    projectId: string,
    domain: string,
    ipAddress?: string,
    userAgent?: string,
    source?: AuditSource
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
      source,
    });
  }

  async logApiKeyCreated(
    organizationId: string,
    userId: string,
    keyName: string,
    keyPrefix: string,
    ipAddress?: string,
    userAgent?: string,
    source?: AuditSource
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      action: 'apikey.created',
      description: `Created API key "${keyName}"`,
      metadata: { keyName, keyPrefix },
      ipAddress,
      userAgent,
      source,
    });
  }

  async logApiKeyRevoked(
    organizationId: string,
    userId: string,
    keyName: string,
    ipAddress?: string,
    userAgent?: string,
    source?: AuditSource
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      action: 'apikey.revoked',
      description: `Revoked API key "${keyName}"`,
      metadata: { keyName },
      ipAddress,
      userAgent,
      source,
    });
  }

  /**
   * The organization's SSO (OIDC) connection was saved. Recorded as `settings.updated` with
   * `setting: 'sso'` so no enum migration is needed. The client secret is never written here —
   * only whether it was replaced.
   */
  async logSsoConnectionSaved(
    organizationId: string,
    userId: string,
    connection: { issuer: string; clientId: string; emailDomains: string[]; enforced: boolean; defaultRole: string },
    clientSecretChanged: boolean,
    ipAddress?: string,
    userAgent?: string,
    source?: AuditSource
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      action: 'settings.updated',
      description: `Saved single sign-on connection (${connection.issuer})`,
      metadata: {
        setting: 'sso',
        operation: 'saved',
        issuer: connection.issuer,
        clientId: connection.clientId,
        emailDomains: connection.emailDomains,
        enforced: connection.enforced,
        defaultRole: connection.defaultRole,
        clientSecretChanged,
      },
      ipAddress,
      userAgent,
      source,
    });
  }

  async logSsoConnectionRemoved(
    organizationId: string,
    userId: string,
    ipAddress?: string,
    userAgent?: string,
    source?: AuditSource
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      action: 'settings.updated',
      description: 'Removed single sign-on connection',
      metadata: { setting: 'sso', operation: 'removed' },
      ipAddress,
      userAgent,
      source,
    });
  }

  async logSettingsUpdated(
    organizationId: string,
    userId: string,
    projectId: string,
    setting: string,
    ipAddress?: string,
    userAgent?: string,
    source?: AuditSource,
    changes?: AuditChanges
  ): Promise<void> {
    await this.log({
      organizationId,
      userId,
      projectId,
      action: 'settings.updated',
      description: `Updated ${setting}`,
      metadata: { setting },
      changes,
      ipAddress,
      userAgent,
      source,
    });
  }
}

export const activityService = new ActivityService();
