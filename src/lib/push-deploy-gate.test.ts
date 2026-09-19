import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HTTPException } from 'hono/http-exception';

/**
 * Git-push deploys used to skip every plan-quota check the dashboard path runs. The gate must
 * refuse with the quota's own message, leave a failed deployment behind so the person can see
 * why nothing happened, and let unexpected errors through untouched.
 */
const mocks = vi.hoisted(() => ({
  assertBilling: vi.fn(),
  assertDeployments: vi.fn(),
  assertBuildMinutes: vi.fn(),
  assertStorage: vi.fn(),
  assertBandwidth: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  log: vi.fn(),
  sendNotifications: vi.fn(),
}));

vi.mock('../config/env', () => ({ env: { FRONTEND_URL: 'https://app.example' } }));
vi.mock('../services/organization-billing.service', () => ({
  assertOrganizationCanMutateResources: mocks.assertBilling,
}));
vi.mock('../services/plan-limits.service', () => ({
  planLimitsService: {
    assertDeploymentsQuota: mocks.assertDeployments,
    assertBuildMinutesQuota: mocks.assertBuildMinutes,
    assertStorageQuota: mocks.assertStorage,
    assertBandwidthQuota: mocks.assertBandwidth,
  },
}));
vi.mock('../repositories/deployment.repository', () => ({
  deploymentRepository: { create: mocks.create, update: mocks.update },
}));
vi.mock('../services/activity.service', () => ({ activityService: { log: mocks.log } }));
vi.mock('../services/notification.service', () => ({
  notificationService: { sendNotifications: mocks.sendNotifications },
}));

import { checkPushDeployAllowed, recordRefusedPushDeploy } from './push-deploy-gate';

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.create.mockResolvedValue({ id: 'dep-1' });
});

describe('checkPushDeployAllowed', () => {
  it('allows when every gate passes', async () => {
    expect(await checkPushDeployAllowed('org-1')).toEqual({ allowed: true });
    expect(mocks.assertBandwidth).toHaveBeenCalledWith('org-1', 'en');
  });

  it('refuses with the quota message when a gate throws', async () => {
    mocks.assertDeployments.mockRejectedValue(new HTTPException(403, { message: 'Monthly deployment limit reached' }));
    expect(await checkPushDeployAllowed('org-1')).toEqual({
      allowed: false,
      reason: 'Monthly deployment limit reached',
    });
    // Later gates are not consulted once one refuses.
    expect(mocks.assertStorage).not.toHaveBeenCalled();
  });

  it('refuses on a billing hold too', async () => {
    mocks.assertBilling.mockRejectedValue(new HTTPException(402, { message: 'Payment past due' }));
    expect(await checkPushDeployAllowed('org-1')).toEqual({ allowed: false, reason: 'Payment past due' });
  });

  it('lets unexpected errors through', async () => {
    mocks.assertStorage.mockRejectedValue(new Error('database down'));
    await expect(checkPushDeployAllowed('org-1')).rejects.toThrow('database down');
  });
});

describe('recordRefusedPushDeploy', () => {
  it('leaves a failed deployment, an activity entry and a channel notification', async () => {
    const deployment = await recordRefusedPushDeploy({
      projectId: 'p1',
      organizationId: 'org-1',
      commitHash: 'abc123',
      commitMessage: 'feat',
      branch: 'main',
      reason: 'Monthly deployment limit reached',
    });

    expect(deployment.id).toBe('dep-1');
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', trigger: 'git_push', commitHash: 'abc123', branch: 'main' }),
    );
    expect(mocks.update).toHaveBeenCalledWith('dep-1', {
      status: 'failed',
      errorMessage: '[Plan] Monthly deployment limit reached',
    });
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', projectId: 'p1', action: 'deployment.failed' }),
    );
    expect(mocks.sendNotifications).toHaveBeenCalledWith(
      'p1',
      'deployment.failed',
      expect.objectContaining({ deploymentId: 'dep-1', status: 'failed' }),
    );
  });

  it('does not fail the webhook when channel delivery throws', async () => {
    mocks.sendNotifications.mockRejectedValue(new Error('slack down'));
    await expect(
      recordRefusedPushDeploy({
        projectId: 'p1', organizationId: 'org-1', commitHash: 'abc', branch: 'main', reason: 'x',
      }),
    ).resolves.toEqual({ id: 'dep-1' });
  });
});
