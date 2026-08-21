import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { projectRepository } from '../repositories/project.repository';
import { deploymentRepository } from '../repositories/deployment.repository';
import { githubAppService } from '../services/github-app.service';
import {
  handlePullRequestEvent,
  handlePushEvent,
  type GitHubPullRequestPayload,
  type GitHubPushPayload,
} from '../lib/github-deploy-trigger';
import { previewService } from '../services/preview.service';
import { canOrganizationDeploy } from '../services/organization-billing.service';
import { webhookRateLimiter } from '../middleware/rate-limit';
import { verifyGitHubSignature } from '../lib/github-webhook';
import { verifyGitLabWebhookToken } from '../lib/gitlab-webhook';
import { claimGitHubWebhookDelivery } from '../lib/webhook-dedupe';
import { logger } from '../lib/logger';
import type { AppEnv } from '../types';

// GitHub webhook payload types
// GitHub Pull Request payload
// Route schemas
const WebhookResponseSchema = z.object({
  message: z.string(),
  deploymentId: z.string().optional(),
}).openapi('WebhookResponse');

const webhookRoute = createRoute({
  method: 'post',
  path: '/github/{projectId}',
  tags: ['Webhooks'],
  summary: 'GitHub webhook endpoint',
  description: 'Receives webhook events from GitHub and triggers deployments',
  request: {
    params: z.object({
      projectId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Webhook processed successfully',
      content: {
        'application/json': {
          schema: WebhookResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid webhook payload or signature',
    },
    401: {
      description: 'Webhook secret not configured',
    },
    404: {
      description: 'Project not found',
    },
  },
});

// Router
const webhookRouter = new OpenAPIHono<AppEnv>();

// Apply rate limiting to webhook endpoints
webhookRouter.use('*', webhookRateLimiter);

// GitHub webhook handler
webhookRouter.openapi(webhookRoute, async (c) => {
  const { projectId } = c.req.valid('param');

  // Get raw body for signature verification
  const rawBody = await c.req.text();

  // Get GitHub headers
  const signature = c.req.header('X-Hub-Signature-256');
  const event = c.req.header('X-GitHub-Event') ?? '';
  const deliveryId = c.req.header('X-GitHub-Delivery');

  // Find project
  const project = await projectRepository.findById(projectId);
  if (!project || project.status === 'deleted') {
    throw new HTTPException(404, { message: 'Project not found' });
  }

  /**
   * GitHub "ping" can be received before the repository webhook secret is pasted into GitHub.
   * If a secret exists, we always verify. Other events require a configured secret + valid signature.
   */
  if (event === 'ping') {
    if (project.webhookSecret) {
      if (!signature) {
        throw new HTTPException(400, { message: 'Missing webhook signature' });
      }
      if (!verifyGitHubSignature(rawBody, signature, project.webhookSecret)) {
        throw new HTTPException(400, { message: 'Invalid webhook signature' });
      }
    }
    logger.info({ projectId, deliveryId, event: 'ping' }, 'GitHub webhook ping received');
    const pingFirst = await claimGitHubWebhookDelivery(deliveryId);
    if (!pingFirst) {
      return c.json({ message: 'pong', duplicate: true });
    }
    return c.json({ message: 'pong' });
  }

  if (!project.webhookSecret) {
    throw new HTTPException(401, {
      message:
        'Webhook secret is not configured. Open the project in Pushify and use “Regenerate webhook secret”, then paste the secret into your GitHub webhook settings.',
    });
  }

  if (!signature) {
    throw new HTTPException(400, { message: 'Missing webhook signature' });
  }

  if (!verifyGitHubSignature(rawBody, signature, project.webhookSecret)) {
    throw new HTTPException(400, { message: 'Invalid webhook signature' });
  }

  /**
   * A repository that the GitHub App now covers delivers to the App endpoint as well. Both
   * deliveries carry different ids, so dedupe would not catch them and the push would deploy
   * twice. The App is authoritative once installed, so the legacy hook stands down here.
   */
  if (event !== 'ping') {
    const coveringInstallation = await githubAppService.findInstallationForRepo(
      project.organizationId,
      project.gitRepoUrl ?? ''
    );

    if (coveringInstallation) {
      logger.info(
        { projectId, installationId: coveringInstallation.installationId },
        'Legacy repository webhook ignored: the GitHub App now covers this repository'
      );
      return c.json({
        message: 'This repository is handled by the Pushify GitHub App; the legacy webhook can be removed',
      });
    }
  }

  logger.info({ projectId, deliveryId, event }, 'GitHub webhook received');

  const processDelivery = await claimGitHubWebhookDelivery(deliveryId);
  if (!processDelivery) {
    return c.json({ message: 'Duplicate webhook delivery ignored' });
  }

  // Parse payload
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawBody);
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON payload' });
  }

  if (!(await canOrganizationDeploy(project.organizationId))) {
    return c.json({ message: 'Deployments blocked: organization billing is past due or suspended' });
  }

  // Handle pull_request events for preview deployments
  if (event === 'pull_request') {
    const result = await handlePullRequestEvent(project, rawPayload as GitHubPullRequestPayload);
    return c.json(result);
  }

  // Handle push events for regular deployments
  if (event !== 'push') {
    return c.json({ message: `Event '${event}' ignored` });
  }

  const result = await handlePushEvent(project, rawPayload as GitHubPushPayload);
  return c.json(result);
});

interface GitLabPushPayload {
  object_kind: 'push';
  ref: string;
  checkout_sha: string | null;
  project: { id: number; path_with_namespace: string };
  commits?: { id: string; message: string }[];
}

interface GitLabMergeRequestPayload {
  object_kind: 'merge_request';
  object_attributes: {
    action: string;
    iid: number;
    title: string;
    source_branch: string;
    target_branch: string;
    state: string;
    last_commit: { id: string };
  };
}

const gitlabWebhookRoute = createRoute({
  method: 'post',
  path: '/gitlab/{projectId}',
  tags: ['Webhooks'],
  summary: 'GitLab webhook endpoint',
  request: {
    params: z.object({ projectId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Webhook processed',
      content: { 'application/json': { schema: WebhookResponseSchema } },
    },
  },
});

webhookRouter.openapi(gitlabWebhookRoute, async (c) => {
  const { projectId } = c.req.valid('param');
  const rawBody = await c.req.text();
  const token = c.req.header('X-Gitlab-Token');
  const event = c.req.header('X-Gitlab-Event') ?? '';
  const deliveryId = c.req.header('X-Gitlab-Event-UUID') ?? c.req.header('X-Gitlab-Delivery-UUID');

  const project = await projectRepository.findById(projectId);
  if (!project || project.status === 'deleted') {
    throw new HTTPException(404, { message: 'Project not found' });
  }

  if (!project.webhookSecret) {
    throw new HTTPException(401, {
      message:
        'Webhook secret is not configured. Regenerate the secret in Pushify and set it as the GitLab webhook Secret Token.',
    });
  }

  if (!verifyGitLabWebhookToken(token, project.webhookSecret)) {
    throw new HTTPException(400, { message: 'Invalid GitLab webhook token' });
  }

  const processDelivery = await claimGitHubWebhookDelivery(deliveryId || `gitlab-${Date.now()}`);
  if (!processDelivery) {
    return c.json({ message: 'Duplicate webhook delivery ignored' });
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawBody);
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON payload' });
  }

  const payload = rawPayload as { object_kind?: string };

  if (!(await canOrganizationDeploy(project.organizationId))) {
    return c.json({ message: 'Deployments blocked: organization billing is past due or suspended' });
  }

  if (payload.object_kind === 'merge_request') {
    const mr = rawPayload as GitLabMergeRequestPayload;
    const previewEnabled = await previewService.isPreviewEnabled(project.id);
    if (!previewEnabled) {
      return c.json({ message: 'Preview deployments are disabled for this project' });
    }

    const action = mr.object_attributes.action;
    const prNumber = mr.object_attributes.iid;
    logger.info({ projectId, prNumber, action }, 'Processing GitLab merge_request event');

    if (action === 'open' || action === 'update' || action === 'reopen') {
      const preview = await previewService.createOrUpdatePreview(project.id, {
        prNumber,
        prTitle: mr.object_attributes.title,
        prBranch: mr.object_attributes.source_branch,
        baseBranch: mr.object_attributes.target_branch,
        commitHash: mr.object_attributes.last_commit.id,
      });
      return c.json({
        message: `Preview deployment updated for MR !${prNumber}`,
        previewId: preview.id,
      });
    }

    if (action === 'close' || action === 'merge') {
      await previewService.cleanupPreview(project.id, prNumber);
      return c.json({ message: `Preview cleaned up for MR !${prNumber}` });
    }

    return c.json({ message: `Merge request action '${action}' ignored` });
  }

  if (payload.object_kind !== 'push') {
    return c.json({ message: `Event '${event}' ignored` });
  }

  if (!project.autoDeploy) {
    return c.json({ message: 'Auto-deploy is disabled for this project' });
  }

  const push = rawPayload as GitLabPushPayload;
  const branch = push.ref.replace('refs/heads/', '');
  if (project.gitBranch && branch !== project.gitBranch) {
    return c.json({ message: `Push to '${branch}' ignored, project tracks '${project.gitBranch}'` });
  }

  const commitHash = push.checkout_sha || push.commits?.[0]?.id;
  if (!commitHash) {
    return c.json({ message: 'No commit in push, skipping deployment' });
  }

  const deployment = await deploymentRepository.create({
    projectId: project.id,
    trigger: 'git_push',
    commitHash,
    commitMessage: push.commits?.[0]?.message?.substring(0, 500),
    branch,
  });

  const { scheduleDeploymentProcessing } = await import('../lib/deployment-scheduler');
  await scheduleDeploymentProcessing(deployment.id, project.id);

  logger.info({ projectId, deploymentId: deployment.id }, 'Deployment from GitLab push');

  return c.json({
    message: 'Deployment triggered',
    deploymentId: deployment.id,
  });
});

// ─── Stripe Webhook ───────────────────────────
webhookRouter.post('/stripe', async (c) => {
  const { stripeService } = await import('../services/stripe.service');

  const signature = c.req.header('stripe-signature');
  if (!signature) {
    return c.json({ error: 'Missing stripe-signature header' }, 400);
  }

  try {
    const rawBody = await c.req.text();
    await stripeService.handleWebhookEvent(rawBody, signature);
    return c.json({ received: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    // Log detail server-side; don't echo internal error messages to the caller (L2).
    logger.error({ err, message }, 'Stripe webhook error');
    return c.json({ error: 'Webhook processing failed' }, 400);
  }
});

export { webhookRouter as webhookRoutes };
