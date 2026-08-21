import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { verifyGitHubSignature } from '../lib/github-webhook';
import { claimGitHubWebhookDelivery } from '../lib/webhook-dedupe';
import {
  handlePullRequestEvent,
  handlePushEvent,
  type GitHubPullRequestPayload,
  type GitHubPushPayload,
} from '../lib/github-deploy-trigger';
import { githubAppService, repoFullNameFromUrl } from '../services/github-app.service';
import { canOrganizationDeploy } from '../services/organization-billing.service';
import type { AppEnv } from '../types';

/**
 * The GitHub App's single webhook endpoint.
 *
 * Unlike the per-project hooks it replaces, one delivery arrives here for every repository an
 * installation covers, so the project is resolved from the payload rather than from the URL.
 * Installation lifecycle events keep our copy of the installations in sync.
 */
const appWebhookRouter = new Hono<AppEnv>();

interface InstallationPayload {
  action: string;
  installation: {
    id: number;
    account?: { login?: string; id?: number; type?: string };
    repository_selection?: string;
    suspended_at?: string | null;
  };
}

/** Projects in this installation's organisation that point at the repository the event names. */
async function projectsForRepository(
  installationId: number,
  fullName: string | undefined
): Promise<(typeof projects.$inferSelect)[]> {
  if (!fullName) return [];

  const installation = await githubAppService.findByInstallationId(installationId);
  if (!installation?.organizationId) return [];

  const candidates = await db
    .select()
    .from(projects)
    .where(eq(projects.organizationId, installation.organizationId));

  return candidates.filter(
    (project) =>
      project.status !== 'deleted' &&
      repoFullNameFromUrl(project.gitRepoUrl)?.toLowerCase() === fullName.toLowerCase()
  );
}

appWebhookRouter.post('/github/app', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('X-Hub-Signature-256');
  const event = c.req.header('X-GitHub-Event') ?? '';
  const deliveryId = c.req.header('X-GitHub-Delivery');

  if (!env.GITHUB_APP_WEBHOOK_SECRET) {
    throw new HTTPException(503, { message: 'GitHub App webhooks are not configured' });
  }

  if (!signature || !verifyGitHubSignature(rawBody, signature, env.GITHUB_APP_WEBHOOK_SECRET)) {
    throw new HTTPException(400, { message: 'Invalid webhook signature' });
  }

  if (event === 'ping') {
    return c.json({ message: 'pong' });
  }

  // GitHub retries deliveries; the same id must never deploy twice.
  const processDelivery = await claimGitHubWebhookDelivery(deliveryId);
  if (!processDelivery) {
    return c.json({ message: 'Duplicate webhook delivery ignored' });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON payload' });
  }

  // ---- Installation lifecycle ----

  if (event === 'installation' || event === 'installation_repositories') {
    const body = payload as InstallationPayload;
    const installation = body.installation;

    if (!installation?.id) {
      throw new HTTPException(400, { message: 'Missing installation in payload' });
    }

    switch (body.action) {
      case 'deleted':
        await githubAppService.removeInstallation(installation.id);
        logger.info({ installationId: installation.id }, 'GitHub App installation removed');
        return c.json({ message: 'Installation removed' });

      case 'suspend':
        await githubAppService.setSuspended(installation.id, true);
        return c.json({ message: 'Installation suspended' });

      case 'unsuspend':
        await githubAppService.setSuspended(installation.id, false);
        return c.json({ message: 'Installation resumed' });

      default: {
        // created, new_permissions_accepted, added, removed — all of them just resync.
        await githubAppService.syncInstallation({
          installationId: installation.id,
          accountLogin: installation.account?.login ?? 'unknown',
          accountId: installation.account?.id ?? null,
          accountType: installation.account?.type ?? null,
          repositorySelection: installation.repository_selection ?? null,
          suspended: Boolean(installation.suspended_at),
        });
        logger.info(
          { installationId: installation.id, action: body.action },
          'GitHub App installation synced'
        );
        return c.json({ message: 'Installation synced' });
      }
    }
  }

  // ---- Repository events ----

  if (event !== 'push' && event !== 'pull_request') {
    return c.json({ message: `Event '${event}' ignored` });
  }

  const repositoryEvent = payload as (GitHubPushPayload | GitHubPullRequestPayload) & {
    installation?: { id?: number };
  };
  const installationId = repositoryEvent.installation?.id;

  if (!installationId) {
    return c.json({ message: 'Event carries no installation, ignored' });
  }

  const targets = await projectsForRepository(installationId, repositoryEvent.repository?.full_name);
  if (targets.length === 0) {
    return c.json({ message: 'No project tracks this repository' });
  }

  const results: { projectId: string; message: string; deploymentId?: string }[] = [];

  for (const project of targets) {
    if (!(await canOrganizationDeploy(project.organizationId))) {
      results.push({
        projectId: project.id,
        message: 'Deployments blocked: organization billing is past due or suspended',
      });
      continue;
    }

    const outcome =
      event === 'push'
        ? await handlePushEvent(project, repositoryEvent as GitHubPushPayload)
        : await handlePullRequestEvent(project, repositoryEvent as GitHubPullRequestPayload);

    results.push({ projectId: project.id, ...outcome });
  }

  logger.info(
    { installationId, event, projects: results.length },
    'GitHub App repository event processed'
  );

  return c.json({ message: 'Processed', results });
});

export { appWebhookRouter as githubAppWebhookRoutes };
