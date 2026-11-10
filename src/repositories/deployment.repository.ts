import { eq, desc, and, ne, lt, isNull, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { deployments, type DeploymentBuildMetadata } from '../db/schema/deployments';
import { projects } from '../db/schema/projects';
import type { ComposeBuildBaseline } from '../lib/compose-build-cache';

type DeploymentStatus = 'pending' | 'building' | 'deploying' | 'running' | 'failed' | 'stopped' | 'cancelled';
type DeploymentTrigger = 'manual' | 'git_push' | 'rollback' | 'redeploy';

interface CreateDeploymentInput {
  projectId: string;
  trigger?: DeploymentTrigger;
  commitHash?: string;
  commitMessage?: string;
  branch?: string;
  triggeredById?: string;
  isPreview?: boolean;
  previewPrNumber?: number;
  /** production (default) | staging */
  environment?: string;
  /** The staging deployment this production deploy promotes */
  promotedFromDeploymentId?: string;
  rollbackFromDeploymentId?: string; // For quick rollback
  buildMetadata?: DeploymentBuildMetadata;
}

interface UpdateDeploymentInput {
  status?: DeploymentStatus;
  buildLogs?: string;
  deployLogs?: string;
  errorMessage?: string;
  buildStartedAt?: Date;
  buildFinishedAt?: Date;
  deployStartedAt?: Date;
  deployFinishedAt?: Date;
}

export const deploymentRepository = {
  /**
   * Find deployment by ID
   */
  async findById(id: string) {
    const result = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, id))
      .limit(1);
    return result[0] || null;
  },

  /**
   * Find deployment by ID with project relation
   */
  /** The newest deployment of one environment, optionally in one status. */
  async findLatestByEnvironment(projectId: string, environment: string, status?: string) {
    const [row] = await db
      .select()
      .from(deployments)
      .where(
        status
          ? and(
              eq(deployments.projectId, projectId),
              eq(deployments.environment, environment),
              eq(deployments.status, status as typeof deployments.$inferSelect['status'])
            )
          : and(eq(deployments.projectId, projectId), eq(deployments.environment, environment))
      )
      .orderBy(desc(deployments.createdAt))
      .limit(1);
    return row;
  },

  async findByIdWithProject(id: string) {
    return db.query.deployments.findFirst({
      where: eq(deployments.id, id),
      with: {
        project: true,
        triggeredBy: {
          columns: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
    });
  },

  /**
   * Find all deployments for a project
   */
  async findByProject(projectId: string, limit: number = 20, offset: number = 0) {
    return db.query.deployments.findMany({
      where: eq(deployments.projectId, projectId),
      orderBy: [desc(deployments.createdAt)],
      limit,
      offset,
      with: {
        triggeredBy: {
          columns: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
      },
    });
  },

  /**
   * Find latest deployment for a project
   */
  async findLatestByProject(projectId: string) {
    const result = await db
      .select()
      .from(deployments)
      .where(eq(deployments.projectId, projectId))
      .orderBy(desc(deployments.createdAt))
      .limit(1);
    return result[0] || null;
  },

  /**
   * Find current running deployment for a project
   */
  async findRunningByProject(projectId: string) {
    const result = await db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.projectId, projectId),
          eq(deployments.status, 'running')
        )
      )
      .limit(1);
    return result[0] || null;
  },

  /**
   * Create new deployment
   */
  async create(input: CreateDeploymentInput) {
    const result = await db
      .insert(deployments)
      .values({
        projectId: input.projectId,
        trigger: input.trigger ?? 'manual',
        commitHash: input.commitHash,
        commitMessage: input.commitMessage,
        branch: input.branch,
        triggeredById: input.triggeredById,
        status: 'pending',
        isPreview: input.isPreview ?? false,
        previewPrNumber: input.previewPrNumber,
        environment: input.environment ?? 'production',
        promotedFromDeploymentId: input.promotedFromDeploymentId,
        rollbackFromDeploymentId: input.rollbackFromDeploymentId,
        buildMetadata: input.buildMetadata,
      })
      .returning();
    return result[0];
  },

  /**
   * What a compose deploy compares its build with: whether it was requested as a forced build,
   * and the deployment of the same copy of the project (environment, preview) created just
   * before it, whatever its status.
   */
  async findComposeBuildBaseline(
    id: string
  ): Promise<{ forceBuild: boolean; previous: ComposeBuildBaseline | null } | null> {
    const current = await this.findById(id);
    if (!current) return null;

    const [previous] = await db
      .select({
        status: deployments.status,
        commitHash: deployments.commitHash,
        buildMetadata: deployments.buildMetadata,
      })
      .from(deployments)
      .where(
        and(
          eq(deployments.projectId, current.projectId),
          eq(deployments.environment, current.environment),
          eq(deployments.isPreview, current.isPreview),
          current.previewPrNumber == null
            ? isNull(deployments.previewPrNumber)
            : eq(deployments.previewPrNumber, current.previewPrNumber),
          lt(deployments.createdAt, current.createdAt)
        )
      )
      .orderBy(desc(deployments.createdAt))
      .limit(1);

    return { forceBuild: current.buildMetadata?.forceBuild === true, previous: previous ?? null };
  },

  /**
   * Cancel the older webhook deploys of the same copy of the project as `newer` — the same branch
   * and environment, or the same PR preview — that are still in one of `statuses`. One UPDATE, so
   * a row the worker moves on meanwhile is left alone (the worker's own moves are conditional too).
   * Closes the build window of a row whose build had started, like updateStatus('cancelled').
   */
  async cancelSuperseded(
    newer: {
      id: string;
      projectId: string;
      createdAt: Date;
      environment: string;
      branch: string | null;
      isPreview: boolean;
      previewPrNumber: number | null;
    },
    statuses: Array<'pending' | 'building'>,
    errorMessage: string
  ) {
    const lane = newer.isPreview
      ? newer.previewPrNumber == null
        ? null
        : and(eq(deployments.isPreview, true), eq(deployments.previewPrNumber, newer.previewPrNumber))
      : newer.branch
        ? and(
            eq(deployments.isPreview, false),
            eq(deployments.environment, newer.environment),
            eq(deployments.branch, newer.branch)
          )
        : null;
    if (!lane || statuses.length === 0) return [];

    return db
      .update(deployments)
      .set({
        status: 'cancelled',
        errorMessage,
        buildFinishedAt: sql`coalesce(${deployments.buildFinishedAt}, case when ${deployments.buildStartedAt} is not null then now() end)`,
      })
      .where(
        and(
          eq(deployments.projectId, newer.projectId),
          eq(deployments.trigger, 'git_push'),
          ne(deployments.id, newer.id),
          lt(deployments.createdAt, newer.createdAt),
          inArray(deployments.status, statuses),
          lane
        )
      )
      .returning({ id: deployments.id, commitHash: deployments.commitHash });
  },

  /**
   * Update deployment
   */
  async update(id: string, input: UpdateDeploymentInput) {
    const result = await db
      .update(deployments)
      .set(input)
      .where(eq(deployments.id, id))
      .returning();
    return result[0] || null;
  },

  /**
   * Update deployment status
   */
  async updateStatus(id: string, status: DeploymentStatus, errorMessage?: string) {
    const updateData: UpdateDeploymentInput = { status };

    const now = new Date();
    switch (status) {
      case 'building':
        updateData.buildStartedAt = now;
        break;
      case 'deploying':
        updateData.buildFinishedAt = now;
        updateData.deployStartedAt = now;
        break;
      case 'running':
        updateData.deployFinishedAt = now;
        break;
      case 'failed':
        updateData.errorMessage = errorMessage;
        await this.closeBuildWindowIfOpen(id, updateData, now);
        break;
      case 'cancelled':
        await this.closeBuildWindowIfOpen(id, updateData, now);
        break;
    }

    return this.update(id, updateData);
  },

  async closeBuildWindowIfOpen(
    id: string,
    updateData: UpdateDeploymentInput,
    now: Date,
  ): Promise<void> {
    const row = await this.findById(id);
    if (row?.buildStartedAt && !row?.buildFinishedAt) {
      updateData.buildFinishedAt = now;
    }
  },

  /**
   * Append to build logs
   */
  async appendBuildLog(id: string, log: string) {
    const deployment = await this.findById(id);
    if (!deployment) return null;

    const newLogs = deployment.buildLogs ? deployment.buildLogs + '\n' + log : log;
    return this.update(id, { buildLogs: newLogs });
  },

  /**
   * Append to deploy logs
   */
  async appendDeployLog(id: string, log: string) {
    const deployment = await this.findById(id);
    if (!deployment) return null;

    const newLogs = deployment.deployLogs ? deployment.deployLogs + '\n' + log : log;
    return this.update(id, { deployLogs: newLogs });
  },

  /**
   * Count deployments for a project
   */
  async countByProject(projectId: string) {
    const result = await db
      .select()
      .from(deployments)
      .where(eq(deployments.projectId, projectId));
    return result.length;
  },

  /**
   * Find all projects that have running deployments (for metrics collection)
   */
  async findProjectsWithRunningDeployments(): Promise<
    Array<{
      projectId: string;
      deploymentId: string;
      slug: string;
      serverId: string | null;
    }>
  > {
    const result = await db
      .select({
        projectId: deployments.projectId,
        deploymentId: deployments.id,
        slug: projects.slug,
        serverId: projects.serverId,
      })
      .from(deployments)
      .innerJoin(projects, eq(deployments.projectId, projects.id))
      .where(
        and(
          eq(deployments.status, 'running'),
          eq(deployments.isPreview, false),
          eq(projects.status, 'active'),
          ne(projects.status, 'deleted')
        )
      )
      .orderBy(desc(deployments.createdAt));

    // One row per project (latest running deployment)
    const byProject = new Map<string, (typeof result)[number]>();
    for (const row of result) {
      if (!byProject.has(row.projectId)) {
        byProject.set(row.projectId, row);
      }
    }
    return Array.from(byProject.values());
  },
};
