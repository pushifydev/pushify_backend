import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  projects: [] as Record<string, unknown>[],
  create: vi.fn(),
  isPreviewEnabled: vi.fn(),
  createOrUpdatePreview: vi.fn(),
  cleanupPreview: vi.fn(),
  canOrganizationDeploy: vi.fn(),
}));

vi.mock('../config/env', () => ({ env: { GITHUB_APP_WEBHOOK_SECRET: 'secret' } }));
vi.mock('../db', () => ({
  db: { select: () => ({ from: () => ({ where: async () => h.projects }) }) },
}));
vi.mock('../services/github-app.service', () => ({
  githubAppService: { findByInstallationId: async () => ({ organizationId: 'org-1' }) },
  repoFullNameFromUrl: (url: string | null) => url?.replace('https://github.com/', '') ?? null,
}));
vi.mock('../repositories/deployment.repository', () => ({ deploymentRepository: { create: h.create } }));
vi.mock('../services/preview.service', () => ({
  previewService: {
    isPreviewEnabled: h.isPreviewEnabled,
    createOrUpdatePreview: h.createOrUpdatePreview,
    cleanupPreview: h.cleanupPreview,
  },
}));
vi.mock('../services/organization-billing.service', () => ({ canOrganizationDeploy: h.canOrganizationDeploy }));
vi.mock('../lib/push-deploy-gate', () => ({
  checkPushDeployAllowed: async () => ({ allowed: true }),
  recordRefusedPushDeploy: vi.fn(),
}));
vi.mock('../lib/github-webhook', () => ({ verifyGitHubSignature: () => true }));
vi.mock('../lib/webhook-dedupe', () => ({
  claimGitHubWebhookDelivery: async () => true,
  processClaimedWebhookDelivery: (_id: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../lib/deployment-scheduler', () => ({ scheduleDeploymentProcessing: vi.fn() }));

import { githubAppWebhookRoutes } from './github-app-webhook';

const deliver = (event: string, body: Record<string, unknown>) =>
  githubAppWebhookRoutes.request('/github/app', {
    method: 'POST',
    headers: {
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': 'delivery-1',
      'X-Hub-Signature-256': 'sha256=ok',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ installation: { id: 1 }, repository: { full_name: 'acme/app' }, ...body }),
  });

const pullRequest = (action: string) =>
  deliver('pull_request', {
    action,
    number: 7,
    pull_request: {
      title: 'PR',
      head: { ref: 'feature', sha: 'deadbeef', repo: { full_name: 'acme/app' } },
      base: { ref: 'main', repo: { full_name: 'acme/app' } },
    },
  });

type AppResponse = { results: { projectId: string; message: string }[] };

describe('GitHub App webhook while billing blocks deployments', () => {
  beforeEach(() => {
    h.projects = [
      {
        id: 'p1',
        name: 'p',
        organizationId: 'org-1',
        status: 'active',
        gitRepoUrl: 'https://github.com/acme/app',
        autoDeploy: true,
        gitBranch: 'main',
      },
    ];
    h.create.mockReset().mockResolvedValue({ id: 'dep-1' });
    h.isPreviewEnabled.mockReset().mockResolvedValue(true);
    h.createOrUpdatePreview.mockReset().mockResolvedValue({ id: 'prev-1' });
    h.cleanupPreview.mockReset().mockResolvedValue(undefined);
    h.canOrganizationDeploy.mockReset().mockResolvedValue(false);
  });

  it('still cleans up the preview when a PR is closed', async () => {
    const res = await pullRequest('closed');
    expect(res.status).toBe(200);
    expect(h.cleanupPreview).toHaveBeenCalledWith('p1', 7);
    expect(((await res.json()) as AppResponse).results[0].message).toContain('cleaned up');
  });

  it.each(['opened', 'synchronize', 'reopened'])('blocks a preview on %s', async (action) => {
    const res = await pullRequest(action);
    expect(((await res.json()) as AppResponse).results[0].message).toContain('Deployments blocked');
    expect(h.createOrUpdatePreview).not.toHaveBeenCalled();
    expect(h.cleanupPreview).not.toHaveBeenCalled();
  });

  it('blocks a push', async () => {
    const res = await deliver('push', { ref: 'refs/heads/main', head_commit: { id: 'abc', message: 'm' } });
    expect(((await res.json()) as AppResponse).results[0].message).toContain('Deployments blocked');
    expect(h.create).not.toHaveBeenCalled();
  });
});
