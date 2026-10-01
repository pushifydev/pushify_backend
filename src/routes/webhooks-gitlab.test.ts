import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  create: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock('../repositories/project.repository', () => ({ projectRepository: { findById: h.findById } }));
vi.mock('../repositories/deployment.repository', () => ({ deploymentRepository: { create: h.create } }));
vi.mock('../services/github-app.service', () => ({ githubAppService: {} }));
vi.mock('../services/preview.service', () => ({ previewService: {} }));
vi.mock('../services/organization-billing.service', () => ({ canOrganizationDeploy: async () => true }));
vi.mock('../lib/push-deploy-gate', () => ({
  checkPushDeployAllowed: async () => ({ allowed: true }),
  recordRefusedPushDeploy: vi.fn(),
}));
vi.mock('../middleware/rate-limit', () => ({
  webhookRateLimiter: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../lib/webhook-dedupe', () => ({
  claimGitHubWebhookDelivery: async () => true,
  processClaimedWebhookDelivery: (_id: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../lib/deployment-scheduler', () => ({ scheduleDeploymentProcessing: h.schedule }));

import { webhookRoutes } from './webhooks';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

const push = (ref: string) =>
  webhookRoutes.request(`/gitlab/${PROJECT_ID}`, {
    method: 'POST',
    headers: { 'X-Gitlab-Token': 'secret', 'X-Gitlab-Event': 'Push Hook', 'content-type': 'application/json' },
    body: JSON.stringify({
      object_kind: 'push',
      ref,
      checkout_sha: 'abc123',
      project: { id: 1, path_with_namespace: 'g/r' },
      commits: [{ id: 'abc123', message: 'msg' }],
    }),
  });

describe('GitLab push webhook', () => {
  beforeEach(() => {
    h.findById.mockReset().mockResolvedValue({
      id: PROJECT_ID,
      name: 'p',
      organizationId: 'org-1',
      status: 'active',
      webhookSecret: 'secret',
      autoDeploy: true,
      gitBranch: 'main',
      stagingBranch: 'develop',
    });
    h.create.mockReset().mockResolvedValue({ id: 'dep-1' });
    h.schedule.mockReset().mockResolvedValue(undefined);
  });

  it('deploys a push to the staging branch to staging', async () => {
    const res = await push('refs/heads/develop');
    expect(res.status).toBe(200);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ branch: 'develop', environment: 'staging' }));
    expect(await res.json()).toMatchObject({ deploymentId: 'dep-1' });
  });

  it('deploys a push to the production branch to production', async () => {
    await push('refs/heads/main');
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ branch: 'main', environment: 'production' }));
  });

  it('ignores a push to an untracked branch', async () => {
    const res = await push('refs/heads/feature');
    expect(((await res.json()) as { message: string }).message).toContain('ignored');
    expect(h.create).not.toHaveBeenCalled();
  });
});
