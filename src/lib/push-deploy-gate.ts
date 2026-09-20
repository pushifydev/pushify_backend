import { HTTPException } from 'hono/http-exception';
import { env } from '../config/env';
import { deploymentRepository } from '../repositories/deployment.repository';
import { planLimitsService } from '../services/plan-limits.service';
import { assertOrganizationCanMutateResources } from '../services/organization-billing.service';
import { activityService } from '../services/activity.service';
import { notificationService } from '../services/notification.service';
import { logger } from './logger';

/**
 * Plan-quota and billing gate for deployments that start from a git push.
 *
 * The dashboard path (deployment.service.ts) throws on these checks and the person sees the
 * message. A webhook has nobody to show a message to, and the checks were simply absent on
 * this path — so the deploys/month, build-minute, bandwidth and storage caps on the pricing
 * page never applied to the product's main flow. Same checks here; a refusal is recorded as a
 * failed deployment carrying the reason, which is where the person looks when nothing happened.
 */

export type PushDeployGate = { allowed: true } | { allowed: false; reason: string };

export async function checkPushDeployAllowed(organizationId: string): Promise<PushDeployGate> {
  try {
    await assertOrganizationCanMutateResources(organizationId, 'en');
    await planLimitsService.assertDeploymentsQuota(organizationId, 'en');
    await planLimitsService.assertBuildMinutesQuota(organizationId, 'en');
    await planLimitsService.assertStorageQuota(organizationId, 'en');
    await planLimitsService.assertBandwidthQuota(organizationId, 'en');
    return { allowed: true };
  } catch (error) {
    // The gates speak HTTPException (402/403 with a translated message); anything else is a
    // real failure and must surface.
    if (error instanceof HTTPException) return { allowed: false, reason: error.message };
    throw error;
  }
}

export interface RefusedPushDeploy {
  projectId: string;
  organizationId: string;
  commitHash: string;
  commitMessage?: string;
  branch: string;
  reason: string;
}

/** Leave a failed deployment + activity entry + channel notification explaining the refusal. */
export async function recordRefusedPushDeploy(input: RefusedPushDeploy) {
  const deployment = await deploymentRepository.create({
    projectId: input.projectId,
    trigger: 'git_push',
    commitHash: input.commitHash,
    commitMessage: input.commitMessage,
    branch: input.branch,
  });
  const errorMessage = `[Plan] ${input.reason}`;
  await deploymentRepository.update(deployment.id, { status: 'failed', errorMessage });

  await activityService.log({
    organizationId: input.organizationId,
    projectId: input.projectId,
    action: 'deployment.failed',
    description: `Deployment from git push not started: ${input.reason}`,
    metadata: { deploymentId: deployment.id, branch: input.branch, commitHash: input.commitHash },
  });

  try {
    await notificationService.sendNotifications(input.projectId, 'deployment.failed', {
      deploymentId: deployment.id,
      branch: input.branch,
      status: 'failed',
      message: errorMessage,
      url: `${env.FRONTEND_URL}/dashboard/projects/${input.projectId}?tab=deployments&deployment=${deployment.id}`,
    });
  } catch (error) {
    logger.warn({ error, deploymentId: deployment.id }, 'Could not notify channels about refused push deploy');
  }

  logger.warn(
    { projectId: input.projectId, deploymentId: deployment.id, reason: input.reason },
    'Git push deployment refused by plan/billing gate'
  );
  return deployment;
}
