/**
 * Deploys made pointless by a newer push.
 *
 * On a busy branch every push queued its own deploy, and each one was built in turn although only
 * the last commit would stay live. When a webhook queues a deploy, the older webhook deploys of
 * the same copy of the project — the same branch and environment, or the same PR preview — that
 * are still waiting in the queue are cancelled. Only `git_push` deploys cancel others or are
 * cancelled: manual, API, redeploy and rollback deploys are never touched.
 *
 * Project settings (PATCH /api/v1/projects/:projectId/settings):
 * - `cancelSupersededDeploys` (default on): `false` turns this off.
 * - `cancelSupersededBuilds` (default off): `true` also cancels older deploys that are still
 *   `building`; the worker stops them at its next step (deployment.worker.ts). A deploy that
 *   reached `deploying` — the step that starts and switches containers — is never cancelled.
 */
import { deploymentRepository } from '../repositories/deployment.repository';
import { projectRepository } from '../repositories/project.repository';
import { env } from '../config/env';
import { logger } from './logger';

/** Starts the errorMessage of a deploy cancelled this way (shown in the deployment list). */
export const SUPERSEDED_MESSAGE_PREFIX = '[Superseded]';

export interface SupersedingDeployment {
  id: string;
  projectId: string;
  trigger: string;
  createdAt: Date;
  environment: string;
  branch: string | null;
  commitHash: string | null;
  isPreview: boolean;
  previewPrNumber: number | null;
}

/** The statuses of the older webhook deploys a new one cancels, from the project's settings. */
export function supersedeStatuses(settings: unknown): Array<'pending' | 'building'> {
  const s = (settings ?? {}) as Record<string, unknown>;
  if (s.cancelSupersededDeploys === false) return [];
  return s.cancelSupersededBuilds === true ? ['pending', 'building'] : ['pending'];
}

/** Why the older deploy was cancelled, naming the push that replaced it. */
export function supersededMessage(
  newer: Pick<SupersedingDeployment, 'isPreview' | 'previewPrNumber' | 'branch' | 'commitHash'>
): string {
  const target = newer.isPreview ? ` to PR #${newer.previewPrNumber}` : newer.branch ? ` to ${newer.branch}` : '';
  const commit = newer.commitHash ? ` (${newer.commitHash.substring(0, 7)})` : '';
  return `${SUPERSEDED_MESSAGE_PREFIX} Cancelled automatically: a newer push${target}${commit} replaced it`;
}

/**
 * Cancel the older webhook deploys `newer` — a deploy a webhook just queued — makes pointless.
 * Never throws: an old deploy left running must not stop the new one. Returns the cancelled ids.
 */
export async function cancelSupersededDeployments(newer: SupersedingDeployment): Promise<string[]> {
  if (newer.trigger !== 'git_push') return [];

  try {
    const project = await projectRepository.findById(newer.projectId);
    if (!project) return [];
    const statuses = supersedeStatuses(project.settings);
    if (statuses.length === 0) return [];

    const message = supersededMessage(newer);
    const cancelled = await deploymentRepository.cancelSuperseded(newer, statuses, message);
    if (cancelled.length === 0) return [];

    const ids = cancelled.map((row) => row.id);
    logger.info(
      { projectId: newer.projectId, deploymentId: newer.id, cancelled: ids },
      'Cancelled older deploys superseded by a newer push'
    );

    const { wsManager } = await import('./ws');
    for (const id of ids) {
      wsManager
        .publish(`project:${newer.projectId}`, {
          type: 'deployment:status',
          data: { projectId: newer.projectId, deploymentId: id, status: 'cancelled', message },
        })
        .catch(() => {});
    }

    // GitHub answers in its own time; the webhook does not wait for it.
    void reportSupersededOnGitHub(project, cancelled, newer.commitHash, message).catch((err) =>
      logger.warn({ err, projectId: newer.projectId }, 'Could not set the commit status of superseded deploys')
    );

    return ids;
  } catch (err) {
    logger.warn({ err, projectId: newer.projectId, deploymentId: newer.id }, 'Could not cancel superseded deploys');
    return [];
  }
}

/**
 * Mark the cancelled commits `error` with the reason, for projects that report deploys as GitHub
 * commit statuses (`prStatusChecksEnabled`). The newer deploy's own commit is skipped: it shares
 * the status and is about to be deployed.
 */
async function reportSupersededOnGitHub(
  project: { id: string; settings: unknown; gitRepoUrl: string | null },
  cancelled: Array<{ id: string; commitHash: string | null }>,
  newerCommitHash: string | null,
  message: string
): Promise<void> {
  const settings = (project.settings ?? {}) as Record<string, unknown>;
  if (settings.prStatusChecksEnabled !== true || !project.gitRepoUrl) return;

  const { githubService } = await import('../services/github.service');
  const repo = githubService.parseRepoFromUrl(project.gitRepoUrl);
  if (!repo) return;

  const byCommit = new Map<string, string>();
  for (const row of cancelled) {
    if (row.commitHash && row.commitHash !== newerCommitHash && !byCommit.has(row.commitHash)) {
      byCommit.set(row.commitHash, row.id);
    }
  }
  if (byCommit.size === 0) return;

  const { getProjectGitAccessToken } = await import('../services/git-provider-access.service');
  const credential = await getProjectGitAccessToken(project.id);
  if (!credential || credential.provider !== 'github') return;

  for (const [commitHash, deploymentId] of byCommit) {
    await githubService.setCommitStatus(
      credential.token,
      repo.owner,
      repo.repo,
      commitHash,
      'error',
      message,
      `${env.FRONTEND_URL}/dashboard/projects/${project.id}?tab=deployments&deployment=${deploymentId}`
    );
  }
}
