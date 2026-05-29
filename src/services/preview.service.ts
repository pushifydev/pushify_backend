import { HTTPException } from 'hono/http-exception';
import { previewRepository } from '../repositories/preview.repository';
import { projectRepository } from '../repositories/project.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { deploymentRepository } from '../repositories/deployment.repository';
import { githubService } from './github.service';
import { gitlabService } from './gitlab.service';
import { getProjectGitAccessToken } from './git-provider-access.service';
import { decrypt } from '../lib/encryption';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';
import { stopContainer, removeContainer } from '../workers/docker';
import { env } from '../config/env';
import type { PreviewDeployment } from '../db/schema';
import { canOrganizationDeploy } from './organization-billing.service';
import { planLimitsService } from './plan-limits.service';

interface CreatePreviewInput {
  prNumber: number;
  prTitle?: string;
  prBranch: string;
  baseBranch: string;
  commitHash: string;
}

export const previewService = {
  /**
   * Get all preview deployments for a project
   */
  async getPreviewsByProject(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ): Promise<PreviewDeployment[]> {
    // Verify access
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Verify project belongs to organization
    const project = await projectRepository.findById(projectId);
    if (!project || project.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    return previewRepository.findAllByProject(projectId);
  },

  /**
   * Get active preview deployments for a project
   */
  async getActivePreviewsByProject(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ): Promise<PreviewDeployment[]> {
    // Verify access
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Verify project belongs to organization
    const project = await projectRepository.findById(projectId);
    if (!project || project.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    return previewRepository.findActiveByProject(projectId);
  },

  /**
   * Create or update a preview deployment for a PR
   */
  async createOrUpdatePreview(
    projectId: string,
    input: CreatePreviewInput,
    locale: SupportedLocale = 'en',
  ): Promise<PreviewDeployment> {
    const project = await projectRepository.findById(projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    if (!(await canOrganizationDeploy(project.organizationId))) {
      throw new Error('Organization billing does not allow deployments');
    }

    await planLimitsService.assertPreviewDeploymentsAllowed(project.organizationId, locale);
    await planLimitsService.assertDeploymentsQuota(project.organizationId, locale);
    await planLimitsService.assertBuildMinutesQuota(project.organizationId, locale);

    // Check if preview already exists
    const existing = await previewRepository.findByProjectAndPr(projectId, input.prNumber);

    if (existing) {
      // Update existing preview (new commit pushed)
      logger.info(
        { projectId, prNumber: input.prNumber },
        'Updating existing preview deployment'
      );

      // Create a new deployment for the preview
      const deployment = await deploymentRepository.create({
        projectId,
        trigger: 'git_push',
        branch: input.prBranch,
        commitHash: input.commitHash,
        isPreview: true,
        previewPrNumber: input.prNumber,
      });

      // Update preview record
      const preview = await previewRepository.update(existing.id, {
        deploymentId: deployment.id,
        prTitle: input.prTitle,
        status: 'pending',
      });

      return preview!;
    }

    // Create new preview
    logger.info({ projectId, prNumber: input.prNumber }, 'Creating new preview deployment');

    // Create deployment
    const deployment = await deploymentRepository.create({
      projectId,
      trigger: 'git_push',
      branch: input.prBranch,
      commitHash: input.commitHash,
      isPreview: true,
      previewPrNumber: input.prNumber,
    });

    // Generate preview URL and container name
    const previewUrl = this.generatePreviewUrl(project.slug, input.prNumber);
    const containerName = `pushify-preview-${project.slug}-pr-${input.prNumber}`;

    // Create preview record
    const preview = await previewRepository.create({
      projectId,
      deploymentId: deployment.id,
      prNumber: input.prNumber,
      prTitle: input.prTitle,
      prBranch: input.prBranch,
      baseBranch: input.baseBranch,
      previewUrl,
      containerName,
      status: 'pending',
    });

    return preview;
  },

  /**
   * Update preview status after deployment
   */
  async updatePreviewStatus(
    projectId: string,
    prNumber: number,
    status: 'running' | 'failed',
    hostPort?: number
  ): Promise<void> {
    const preview = await previewRepository.findByProjectAndPr(projectId, prNumber);
    if (!preview) return;

    await previewRepository.update(preview.id, {
      status: status === 'running' ? 'running' : 'failed',
      hostPort: hostPort || preview.hostPort,
    });

    if (status === 'running' && !preview.githubCommentId) {
      await this.postPreviewComment(projectId, prNumber, preview.previewUrl!);
    }
  },

  /**
   * Cleanup preview deployment (when PR is closed)
   */
  async cleanupPreview(projectId: string, prNumber: number): Promise<void> {
    const preview = await previewRepository.findByProjectAndPr(projectId, prNumber);
    if (!preview) {
      logger.warn({ projectId, prNumber }, 'Preview not found for cleanup');
      return;
    }

    logger.info({ projectId, prNumber }, 'Cleaning up preview deployment');

    // Stop and remove the container
    if (preview.containerName) {
      try {
        await stopContainer(preview.containerName);
        await removeContainer(preview.containerName);
        logger.info({ containerName: preview.containerName }, 'Preview container removed');
      } catch (error) {
        logger.error({ error, containerName: preview.containerName }, 'Failed to remove preview container');
      }
    }

    // Mark preview as closed
    await previewRepository.close(preview.id);

    await this.updatePreviewComment(projectId, prNumber, 'closed');
  },

  /**
   * Generate preview URL for a PR
   */
  generatePreviewUrl(projectSlug: string, prNumber: number): string {
    const base = env.PREVIEW_BASE_URL?.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (base) {
      return `https://pr-${prNumber}-${projectSlug}.${base}`;
    }
    return `http://localhost/preview/${projectSlug}/pr-${prNumber}`;
  },

  /**
   * Get GitHub access token for a project
   * Looks up the organization owner's GitHub integration
   */
  async getProjectGitHubToken(projectId: string): Promise<string | null> {
    try {
      const project = await projectRepository.findById(projectId);
      if (!project) return null;

      // Get organization owner
      const owner = await organizationRepository.findOwner(project.organizationId);
      if (!owner) return null;

      // Get owner's GitHub integration
      const integration = await githubService.getIntegration(owner.userId);
      if (!integration) return null;

      return decrypt(integration.accessToken);
    } catch (error) {
      logger.error({ error, projectId }, 'Failed to get GitHub token for project');
      return null;
    }
  },

  previewCommentBody(previewUrl: string, kind: 'ready' | 'updated' | 'closed'): string {
    if (kind === 'closed') {
      return `## Preview Deployment Closed 🔴

This preview deployment has been removed because the merge request was closed.

---
*Managed by [Pushify](https://pushify.dev)*`;
    }
    if (kind === 'updated') {
      return `## Preview Deployment Updated 🔄

Your preview deployment has been updated:

**Preview URL:** ${previewUrl}

This preview will be automatically updated when you push new commits to this merge request.

---
*Deployed by [Pushify](https://pushify.dev)*`;
    }
    return `## Preview Deployment Ready 🚀

Your preview deployment is now available:

**Preview URL:** ${previewUrl}

This preview will be automatically updated when you push new commits to this merge request.

---
*Deployed by [Pushify](https://pushify.dev)*`;
  },

  async postPreviewComment(
    projectId: string,
    prNumber: number,
    previewUrl: string,
  ): Promise<void> {
    try {
      const project = await projectRepository.findById(projectId);
      if (!project?.gitRepoUrl) return;

      const auth = await getProjectGitAccessToken(projectId);
      if (!auth) {
        logger.warn({ projectId }, 'No git token available for preview comment');
        return;
      }

      const body = this.previewCommentBody(previewUrl, 'ready');

      if (auth.provider === 'gitlab' || project.gitRepoUrl.includes('gitlab')) {
        const repoInfo = gitlabService.parseRepoFromUrl(project.gitRepoUrl);
        if (!repoInfo) return;
        const noteId = await gitlabService.postMergeRequestNote(
          auth.token,
          repoInfo.pathWithNamespace,
          prNumber,
          body,
        );
        if (noteId) {
          await previewRepository.updateByProjectAndPr(projectId, prNumber, {
            githubCommentId: noteId,
          });
          logger.info({ projectId, prNumber, noteId }, 'Posted GitLab preview note');
        }
        return;
      }

      if (!project.gitRepoUrl.includes('github.com')) return;

      const repoInfo = githubService.parseRepoFromUrl(project.gitRepoUrl);
      if (!repoInfo) return;

      const commentId = await githubService.postPRComment(
        auth.token,
        repoInfo.owner,
        repoInfo.repo,
        prNumber,
        body,
      );

      if (commentId) {
        await previewRepository.updateByProjectAndPr(projectId, prNumber, {
          githubCommentId: commentId,
        });
        logger.info({ projectId, prNumber, commentId }, 'Posted GitHub preview comment');
      }
    } catch (error) {
      logger.error({ error, projectId, prNumber }, 'Failed to post preview comment');
    }
  },

  async updatePreviewComment(
    projectId: string,
    prNumber: number,
    status: 'updated' | 'closed',
  ): Promise<void> {
    try {
      const preview = await previewRepository.findByProjectAndPr(projectId, prNumber);
      if (!preview?.githubCommentId) return;

      const project = await projectRepository.findById(projectId);
      if (!project?.gitRepoUrl) return;

      const auth = await getProjectGitAccessToken(projectId);
      if (!auth) return;

      const body =
        status === 'closed'
          ? this.previewCommentBody('', 'closed')
          : this.previewCommentBody(preview.previewUrl || '', 'updated');

      if (auth.provider === 'gitlab' || project.gitRepoUrl.includes('gitlab')) {
        const repoInfo = gitlabService.parseRepoFromUrl(project.gitRepoUrl);
        if (!repoInfo) return;
        await gitlabService.postMergeRequestNote(
          auth.token,
          repoInfo.pathWithNamespace,
          prNumber,
          body,
          Number(preview.githubCommentId),
        );
        logger.info({ projectId, prNumber, status }, 'Updated GitLab preview note');
        return;
      }

      if (!project.gitRepoUrl.includes('github.com')) return;

      const repoInfo = githubService.parseRepoFromUrl(project.gitRepoUrl);
      if (!repoInfo) return;

      await githubService.postPRComment(
        auth.token,
        repoInfo.owner,
        repoInfo.repo,
        prNumber,
        body,
        Number(preview.githubCommentId),
      );

      logger.info({ projectId, prNumber, status }, 'Updated GitHub preview comment');
    } catch (error) {
      logger.error({ error, projectId, prNumber }, 'Failed to update preview comment');
    }
  },

  /**
   * Check if preview deployments are enabled for a project
   */
  async isPreviewEnabled(projectId: string): Promise<boolean> {
    const project = await projectRepository.findById(projectId);
    if (!project) return false;

    const settings = project.settings as Record<string, unknown> | null;
    return settings?.previewDeploymentsEnabled === true;
  },
};
