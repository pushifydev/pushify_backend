import { env } from '../config/env';
import { deploymentAlertRepository } from '../repositories/deployment-alert.repository';
import { sendDeploymentFailedEmail, sendDeploymentRecoveredEmail } from '../lib/email';
import { logger } from '../lib/logger';

/**
 * Personal "Deployment alerts" emails — the toggle in Settings → Notifications. It existed and
 * was saved, but nothing ever read it. Now: every member who keeps it on gets an email when a
 * production deployment fails, and one more when the next deployment succeeds after a failure.
 * Successes on their own are not mailed (that is what per-project channels are for); preview
 * deployments are never mailed.
 */

export interface DeploymentAlertProject {
  id: string;
  name: string;
  organizationId: string;
}

export interface DeploymentAlertPayload {
  deploymentId?: string;
  branch?: string;
  message?: string;
  url?: string;
}

export const deploymentAlertService = {
  async handleDeploymentEvent(
    event: string,
    project: DeploymentAlertProject,
    payload: DeploymentAlertPayload,
  ): Promise<{ sent: number; kind: 'failed' | 'recovered' | null }> {
    if ((event !== 'deployment.failed' && event !== 'deployment.success') || !payload.deploymentId) {
      return { sent: 0, kind: null };
    }

    const deployment = await deploymentAlertRepository.findDeployment(payload.deploymentId);
    if (!deployment || deployment.isPreview) return { sent: 0, kind: null };

    let kind: 'failed' | 'recovered';
    if (event === 'deployment.failed') {
      kind = 'failed';
    } else {
      const previous = await deploymentAlertRepository.previousDeploymentStatus(
        project.id,
        deployment.createdAt,
        deployment.id,
      );
      if (previous !== 'failed') return { sent: 0, kind: null };
      kind = 'recovered';
    }

    const recipients = await deploymentAlertRepository.findAlertRecipients(project.organizationId);
    if (recipients.length === 0) return { sent: 0, kind };

    const url =
      payload.url ??
      `${env.FRONTEND_URL}/dashboard/projects/${project.id}?tab=deployments&deployment=${deployment.id}`;
    const branch = payload.branch ?? deployment.branch ?? undefined;

    await Promise.all(
      recipients.map((r) =>
        kind === 'failed'
          ? sendDeploymentFailedEmail(r.email, {
              projectName: project.name,
              branch,
              error: payload.message ?? deployment.errorMessage ?? undefined,
              url,
            })
          : sendDeploymentRecoveredEmail(r.email, { projectName: project.name, branch, url }),
      ),
    );

    logger.info({ projectId: project.id, deploymentId: deployment.id, kind, recipients: recipients.length }, 'Deployment alert emails sent');
    return { sent: recipients.length, kind };
  },
};
