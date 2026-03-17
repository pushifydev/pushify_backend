import { eq, desc, and } from 'drizzle-orm';
import { db } from '../db';
import { deployments } from '../db/schema/deployments';
import { projects } from '../db/schema/projects';

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
  rollbackFromDeploymentId?: string; // For quick rollback
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
        rollbackFromDeploymentId: input.rollbackFromDeploymentId,
      })
      .returning();
    return result[0];
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

    // Set timestamps based on status
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
        break;
    }

    return this.update(id, updateData);
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
    }>
  > {
    const result = await db
      .select({
        projectId: deployments.projectId,
        deploymentId: deployments.id,
        slug: projects.slug,
      })
      .from(deployments)
      .innerJoin(projects, eq(deployments.projectId, projects.id))
      .where(
        and(
          eq(deployments.status, 'running'),
          eq(deployments.isPreview, false)
        )
      );

    return result;
  },
};
