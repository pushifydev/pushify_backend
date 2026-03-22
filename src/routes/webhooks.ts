import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import crypto from 'crypto';
import { projectRepository } from '../repositories/project.repository';
import { deploymentRepository } from '../repositories/deployment.repository';
import { previewService } from '../services/preview.service';
import { webhookRateLimiter } from '../middleware/rate-limit';
import { logger } from '../lib/logger';
import type { AppEnv } from '../types';

// GitHub webhook payload types
interface GitHubPushPayload {
  ref: string; // refs/heads/main
  before: string;
  after: string;
  repository: {
    id: number;
    full_name: string;
    html_url: string;
    clone_url: string;
    ssh_url: string;
    default_branch: string;
  };
  pusher: {
    name: string;
    email: string;
  };
  head_commit: {
    id: string;
    message: string;
    timestamp: string;
    author: {
      name: string;
      email: string;
    };
  } | null;
}

// GitHub Pull Request payload
interface GitHubPullRequestPayload {
  action: 'opened' | 'synchronize' | 'closed' | 'reopened' | string;
  number: number;
  pull_request: {
    id: number;
    number: number;
    title: string;
    state: 'open' | 'closed';
    merged: boolean;
    head: {
      ref: string; // branch name
      sha: string; // commit hash
    };
    base: {
      ref: string; // target branch
    };
    user: {
      login: string;
    };
  };
  repository: {
    id: number;
    full_name: string;
    html_url: string;
  };
}

// Verify GitHub webhook signature
function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

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
  const event = c.req.header('X-GitHub-Event');
  const deliveryId = c.req.header('X-GitHub-Delivery');

  console.log(`[Webhook] Received ${event} event for project ${projectId}, delivery: ${deliveryId}`);

  // Find project
  const project = await projectRepository.findById(projectId);
  if (!project || project.status === 'deleted') {
    throw new HTTPException(404, { message: 'Project not found' });
  }

  // Verify signature if webhook secret is set
  if (project.webhookSecret) {
    if (!signature) {
      throw new HTTPException(400, { message: 'Missing webhook signature' });
    }

    try {
      const isValid = verifyGitHubSignature(rawBody, signature, project.webhookSecret);
      if (!isValid) {
        throw new HTTPException(400, { message: 'Invalid webhook signature' });
      }
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(400, { message: 'Signature verification failed' });
    }
  }

  // Parse payload
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawBody);
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON payload' });
  }

  // Handle pull_request events for preview deployments
  if (event === 'pull_request') {
    const payload = rawPayload as GitHubPullRequestPayload;

    // Check if preview deployments are enabled
    const previewEnabled = await previewService.isPreviewEnabled(project.id);
    if (!previewEnabled) {
      return c.json({ message: 'Preview deployments are disabled for this project' });
    }

    const { action, number: prNumber, pull_request: pr } = payload;
    logger.info({ projectId, prNumber, action }, 'Processing pull_request event');

    switch (action) {
      case 'opened':
      case 'synchronize':
      case 'reopened': {
        // Create or update preview deployment
        const preview = await previewService.createOrUpdatePreview(project.id, {
          prNumber,
          prTitle: pr.title,
          prBranch: pr.head.ref,
          baseBranch: pr.base.ref,
          commitHash: pr.head.sha,
        });

        logger.info({ projectId, prNumber, previewId: preview.id }, 'Preview deployment created/updated');
        return c.json({
          message: `Preview deployment ${action === 'opened' ? 'created' : 'updated'} for PR #${prNumber}`,
          previewId: preview.id,
        });
      }

      case 'closed': {
        // Cleanup preview deployment
        await previewService.cleanupPreview(project.id, prNumber);
        logger.info({ projectId, prNumber }, 'Preview deployment cleaned up');
        return c.json({
          message: `Preview deployment cleaned up for PR #${prNumber}`,
        });
      }

      default:
        return c.json({ message: `Pull request action '${action}' ignored` });
    }
  }

  // Handle push events for regular deployments
  if (event !== 'push') {
    return c.json({ message: `Event '${event}' ignored` });
  }

  // Check if auto-deploy is enabled
  if (!project.autoDeploy) {
    return c.json({ message: 'Auto-deploy is disabled for this project' });
  }

  const payload = rawPayload as GitHubPushPayload;

  // Extract branch from ref (refs/heads/main -> main)
  const branch = payload.ref.replace('refs/heads/', '');

  // Only deploy if push is to the configured branch
  if (project.gitBranch && branch !== project.gitBranch) {
    return c.json({ message: `Push to '${branch}' ignored, project tracks '${project.gitBranch}'` });
  }

  // Skip if no commits (e.g., branch deletion)
  if (!payload.head_commit) {
    return c.json({ message: 'No commits in push, skipping deployment' });
  }

  // Create deployment
  const deployment = await deploymentRepository.create({
    projectId: project.id,
    trigger: 'git_push',
    commitHash: payload.head_commit.id,
    commitMessage: payload.head_commit.message.substring(0, 500), // Limit length
    branch,
  });

  console.log(`[Webhook] Created deployment ${deployment.id} for project ${project.name}`);

  return c.json({
    message: 'Deployment triggered',
    deploymentId: deployment.id,
  });
});

// Ping event handler (sent when webhook is first created)
webhookRouter.post('/github/:projectId/ping', async (c) => {
  const projectId = c.req.param('projectId');
  console.log(`[Webhook] Received ping for project ${projectId}`);
  return c.json({ message: 'pong' });
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
    logger.error({ err }, 'Stripe webhook error');
    return c.json({ error: 'Webhook processing failed' }, 400);
  }
});

export { webhookRouter as webhookRoutes };
