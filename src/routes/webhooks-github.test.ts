import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  create: vi.fn(),
  isPreviewEnabled: vi.fn(),
  createOrUpdatePreview: vi.fn(),
  cleanupPreview: vi.fn(),
  canOrganizationDeploy: vi.fn(),
}));

vi.mock('../repositories/project.repository', () => ({ projectRepository: { findById: h.findById } }));
vi.mock('../repositories/deployment.repository', () => ({ deploymentRepository: { create: h.create } }));
vi.mock('../services/github-app.service', () => ({
  githubAppService: { findInstallationForRepo: async () => null },
}));
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
vi.mock('../middleware/rate-limit', () => ({
  webhookRateLimiter: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../lib/webhook-dedupe', () => ({
  claimGitHubWebhookDelivery: async () => true,
  processClaimedWebhookDelivery: (_id: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../lib/deployment-scheduler', () => ({ scheduleDeploymentProcessing: vi.fn() }));

import { webhookRoutes } from './webhooks';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

const deliver = (event: string, body: unknown) =>
  webhookRoutes.request(`/github/${PROJECT_ID}`, {
    method: 'POST',
    headers: {
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': 'delivery-1',
      'X-Hub-Signature-256': 'sha256=ok',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
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
    repository: { full_name: 'acme/app' },
  });

describe('GitHub webhook while billing blocks deployments', () => {
  beforeEach(() => {
    h.findById.mockReset().mockResolvedValue({
      id: PROJECT_ID,
      name: 'p',
      organizationId: 'org-1',
      status: 'active',
      webhookSecret: 'secret',
      gitRepoUrl: 'https://github.com/acme/app',
      autoDeploy: true,
      gitBranch: 'main',
    });
    h.create.mockReset().mockResolvedValue({ id: 'dep-1' });
    h.isPreviewEnabled.mockReset().mockResolvedValue(true);
    h.createOrUpdatePreview.mockReset().mockResolvedValue({ id: 'prev-1' });
    h.cleanupPreview.mockReset().mockResolvedValue(undefined);
    h.canOrganizationDeploy.mockReset().mockResolvedValue(false);
  });

  it('still cleans up the preview when a PR is closed', async () => {
    const res = await pullRequest('closed');
    expect(res.status).toBe(200);
    expect(h.cleanupPreview).toHaveBeenCalledWith(PROJECT_ID, 7);
    expect(((await res.json()) as { message: string }).message).toContain('cleaned up');
  });

  it.each(['opened', 'synchronize', 'reopened'])('blocks a preview on %s', async (action) => {
    const res = await pullRequest(action);
    expect(((await res.json()) as { message: string }).message).toContain('Deployments blocked');
    expect(h.createOrUpdatePreview).not.toHaveBeenCalled();
    expect(h.cleanupPreview).not.toHaveBeenCalled();
  });

  it('blocks a push', async () => {
    const res = await deliver('push', { ref: 'refs/heads/main', head_commit: { id: 'abc', message: 'm' } });
    expect(((await res.json()) as { message: string }).message).toContain('Deployments blocked');
    expect(h.create).not.toHaveBeenCalled();
  });

  it('does not treat a closed-looking body on another event as teardown', async () => {
    const res = await deliver('issues', { action: 'closed', pull_request: {} });
    expect(((await res.json()) as { message: string }).message).toContain('Deployments blocked');
    expect(h.cleanupPreview).not.toHaveBeenCalled();
  });

  it('builds previews again once billing is active', async () => {
    h.canOrganizationDeploy.mockResolvedValue(true);
    const res = await pullRequest('opened');
    expect(h.createOrUpdatePreview).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({ previewId: 'prev-1' });
  });
});
