/**
 * What a GitHub push or pull-request event does to a project.
 *
 * Extracted from the per-project webhook route so the GitHub App endpoint — which receives one
 * delivery for every repository an installation covers — runs exactly the same logic instead of
 * a second copy that could drift.
 */
import { deploymentRepository } from '../repositories/deployment.repository';
import { previewService } from '../services/preview.service';
import { logger } from './logger';

export interface GitHubPushPayload {
  ref: string;
  head_commit: { id: string; message: string } | null;
  repository?: { full_name?: string };
}

export interface GitHubPullRequestPayload {
  action: string;
  number: number;
  pull_request: {
    title: string;
    head: { ref: string; sha: string };
    base: { ref: string };
  };
  repository?: { full_name?: string };
}

/** The project fields these handlers need; keeps the signature independent of the row type. */
export interface DeployTargetProject {
  id: string;
  name: string;
  organizationId: string;
  autoDeploy: boolean | null;
  gitBranch: string | null;
}

export interface TriggerResult {
  message: string;
  deploymentId?: string;
  previewId?: string;
}

export async function handlePushEvent(
  project: DeployTargetProject,
  payload: GitHubPushPayload
): Promise<TriggerResult> {
  if (!project.autoDeploy) {
    return { message: 'Auto-deploy is disabled for this project' };
  }

  // refs/heads/main -> main
  const branch = payload.ref.replace('refs/heads/', '');

  if (project.gitBranch && branch !== project.gitBranch) {
    return { message: `Push to '${branch}' ignored, project tracks '${project.gitBranch}'` };
  }

  // No commits means something like a branch deletion.
  if (!payload.head_commit) {
    return { message: 'No commits in push, skipping deployment' };
  }

  const deployment = await deploymentRepository.create({
    projectId: project.id,
    trigger: 'git_push',
    commitHash: payload.head_commit.id,
    commitMessage: payload.head_commit.message.substring(0, 500),
    branch,
  });

  const { scheduleDeploymentProcessing } = await import('./deployment-scheduler');
  await scheduleDeploymentProcessing(deployment.id, project.id);

  logger.info(
    { projectId: project.id, deploymentId: deployment.id, projectName: project.name },
    'Deployment created from GitHub push webhook'
  );

  return { message: 'Deployment triggered', deploymentId: deployment.id };
}

export async function handlePullRequestEvent(
  project: DeployTargetProject,
  payload: GitHubPullRequestPayload
): Promise<TriggerResult> {
  const previewEnabled = await previewService.isPreviewEnabled(project.id);
  if (!previewEnabled) {
    return { message: 'Preview deployments are disabled for this project' };
  }

  const { action, number: prNumber, pull_request: pr } = payload;
  logger.info({ projectId: project.id, prNumber, action }, 'Processing pull_request event');

  switch (action) {
    case 'opened':
    case 'synchronize':
    case 'reopened': {
      const preview = await previewService.createOrUpdatePreview(project.id, {
        prNumber,
        prTitle: pr.title,
        prBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        commitHash: pr.head.sha,
      });

      logger.info(
        { projectId: project.id, prNumber, previewId: preview.id },
        'Preview deployment created/updated'
      );

      return {
        message: `Preview deployment ${action === 'opened' ? 'created' : 'updated'} for PR #${prNumber}`,
        previewId: preview.id,
      };
    }

    case 'closed': {
      await previewService.cleanupPreview(project.id, prNumber);
      logger.info({ projectId: project.id, prNumber }, 'Preview deployment cleaned up');
      return { message: `Preview deployment cleaned up for PR #${prNumber}` };
    }

    default:
      return { message: `Pull request action '${action}' ignored` };
  }
}
