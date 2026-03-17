import { HTTPException } from 'hono/http-exception';
import { deploymentRepository } from '../repositories/deployment.repository';
import { projectRepository } from '../repositories/project.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { t, type SupportedLocale } from '../i18n';

type DeploymentTrigger = 'manual' | 'git_push' | 'rollback' | 'redeploy';

interface CreateDeploymentInput {
  commitHash?: string;
  commitMessage?: string;
  branch?: string;
  trigger?: DeploymentTrigger;
  rollbackFromDeploymentId?: string; // For quick rollback
}

export const deploymentService = {
  /**
   * Check if user has access to project
   */
  async checkProjectAccess(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    // Verify organization membership
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Verify project exists and belongs to organization
    const project = await projectRepository.findById(projectId);
    if (!project || project.organizationId !== organizationId || project.status === 'deleted') {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    return project;
  },

  /**
   * Get all deployments for a project
   */
  async getByProject(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale,
    limit: number = 20,
    offset: number = 0
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale);
    return deploymentRepository.findByProject(projectId, limit, offset);
  },

  /**
   * Get single deployment
   */
  async getById(
    deploymentId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale);

    const deployment = await deploymentRepository.findByIdWithProject(deploymentId);
    if (!deployment || deployment.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'deployments', 'notFound') });
    }

    return deployment;
  },

  /**
   * Create new deployment (trigger a deploy)
   */
  async create(
    projectId: string,
    organizationId: string,
    userId: string,
    input: CreateDeploymentInput,
    locale: SupportedLocale
  ) {
    const project = await this.checkProjectAccess(projectId, organizationId, userId, locale);

    // Check if project is paused
    if (project.status === 'paused') {
      throw new HTTPException(400, { message: t(locale, 'deployments', 'projectPaused') });
    }

    // Create deployment record with 'pending' status
    // The deployment worker will pick it up and process it
    // Branch priority: explicit input > project settings > null (worker will use git default)
    const deployment = await deploymentRepository.create({
      projectId,
      trigger: input.trigger ?? 'manual',
      commitHash: input.commitHash,
      commitMessage: input.commitMessage,
      branch: input.branch || project.gitBranch || undefined,
      triggeredById: userId,
      rollbackFromDeploymentId: input.rollbackFromDeploymentId,
    });

    // Deployment worker polls for pending deployments and processes them automatically

    return deployment;
  },

  /**
   * Cancel a deployment
   */
  async cancel(
    deploymentId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale);

    const deployment = await deploymentRepository.findById(deploymentId);
    if (!deployment || deployment.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'deployments', 'notFound') });
    }

    // Can only cancel pending or building deployments
    if (!['pending', 'building', 'deploying'].includes(deployment.status)) {
      throw new HTTPException(400, { message: t(locale, 'deployments', 'cannotCancel') });
    }

    return deploymentRepository.updateStatus(deploymentId, 'cancelled');
  },

  /**
   * Redeploy (create new deployment from existing one)
   */
  async redeploy(
    deploymentId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale);

    const deployment = await deploymentRepository.findById(deploymentId);
    if (!deployment || deployment.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'deployments', 'notFound') });
    }

    // Create new deployment with same commit info
    return this.create(
      projectId,
      organizationId,
      userId,
      {
        commitHash: deployment.commitHash ?? undefined,
        commitMessage: deployment.commitMessage ?? undefined,
        branch: deployment.branch ?? undefined,
        trigger: 'redeploy',
      },
      locale
    );
  },

  /**
   * Rollback to a previous deployment
   * If the target deployment has a Docker image, uses quick rollback (no rebuild)
   */
  async rollback(
    deploymentId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale);

    const deployment = await deploymentRepository.findById(deploymentId);
    if (!deployment || deployment.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'deployments', 'notFound') });
    }

    // Can only rollback to a previously successful deployment
    if (deployment.status !== 'running' && deployment.status !== 'stopped') {
      throw new HTTPException(400, { message: t(locale, 'deployments', 'cannotRollback') });
    }

    // Create new deployment as rollback
    // Include rollbackFromDeploymentId for quick rollback support
    return this.create(
      projectId,
      organizationId,
      userId,
      {
        commitHash: deployment.commitHash ?? undefined,
        commitMessage: `Rollback to ${deployment.commitHash?.substring(0, 7) || deployment.id.substring(0, 8)}`,
        branch: deployment.branch ?? undefined,
        trigger: 'rollback',
        rollbackFromDeploymentId: deployment.dockerImageId ? deploymentId : undefined, // Only set if image exists
      },
      locale
    );
  },

  /**
   * Get deployment logs
   */
  async getLogs(
    deploymentId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale,
    logType: 'build' | 'deploy' = 'build'
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale);

    const deployment = await deploymentRepository.findById(deploymentId);
    if (!deployment || deployment.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'deployments', 'notFound') });
    }

    return {
      logs: logType === 'build' ? deployment.buildLogs : deployment.deployLogs,
      status: deployment.status,
    };
  },

  /**
   * Get deployment status and logs for streaming
   */
  async getDeploymentForStreaming(
    deploymentId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale);

    const deployment = await deploymentRepository.findById(deploymentId);
    if (!deployment || deployment.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'deployments', 'notFound') });
    }

    return {
      id: deployment.id,
      status: deployment.status,
      buildLogs: deployment.buildLogs,
      errorMessage: deployment.errorMessage,
    };
  },
};
