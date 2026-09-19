import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Settings → Notifications "Deployment alerts" toggle used to be stored and never read.
 * These pin down who gets mailed and when: failures always, successes only as a recovery,
 * never for previews, and only to members who left the toggle on.
 */
const mocks = vi.hoisted(() => ({
  findDeployment: vi.fn(),
  previousDeploymentStatus: vi.fn(),
  findAlertRecipients: vi.fn(),
  sendFailed: vi.fn(),
  sendRecovered: vi.fn(),
}));

vi.mock('../config/env', () => ({ env: { FRONTEND_URL: 'https://app.example' } }));
vi.mock('../repositories/deployment-alert.repository', () => ({
  deploymentAlertRepository: {
    findDeployment: mocks.findDeployment,
    previousDeploymentStatus: mocks.previousDeploymentStatus,
    findAlertRecipients: mocks.findAlertRecipients,
  },
}));
vi.mock('../lib/email', () => ({
  sendDeploymentFailedEmail: mocks.sendFailed,
  sendDeploymentRecoveredEmail: mocks.sendRecovered,
}));

import { deploymentAlertService } from './deployment-alert.service';

const project = { id: 'p1', name: 'shop', organizationId: 'org-1' };
const deployment = { id: 'd2', projectId: 'p1', isPreview: false, branch: 'main', errorMessage: 'build failed', createdAt: new Date('2026-09-19T10:00:00Z') };

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.findDeployment.mockResolvedValue(deployment);
  mocks.findAlertRecipients.mockResolvedValue([{ email: 'a@x.dev', name: 'A' }, { email: 'b@x.dev', name: 'B' }]);
});

describe('deploymentAlertService', () => {
  it('mails every opted-in member when a production deployment fails', async () => {
    const result = await deploymentAlertService.handleDeploymentEvent('deployment.failed', project, {
      deploymentId: 'd2', branch: 'main', message: 'npm ERR! build', url: 'https://app.example/x',
    });
    expect(result).toEqual({ sent: 2, kind: 'failed' });
    expect(mocks.sendFailed).toHaveBeenCalledTimes(2);
    expect(mocks.sendFailed).toHaveBeenCalledWith('a@x.dev', expect.objectContaining({ projectName: 'shop', branch: 'main', error: 'npm ERR! build' }));
    expect(mocks.sendRecovered).not.toHaveBeenCalled();
  });

  it('mails a recovery only when the previous production deployment had failed', async () => {
    mocks.previousDeploymentStatus.mockResolvedValue('failed');
    expect(await deploymentAlertService.handleDeploymentEvent('deployment.success', project, { deploymentId: 'd2' })).toEqual({ sent: 2, kind: 'recovered' });
    expect(mocks.sendRecovered).toHaveBeenCalledTimes(2);

    mocks.sendRecovered.mockReset();
    mocks.previousDeploymentStatus.mockResolvedValue('running');
    expect(await deploymentAlertService.handleDeploymentEvent('deployment.success', project, { deploymentId: 'd2' })).toEqual({ sent: 0, kind: null });
    expect(mocks.sendRecovered).not.toHaveBeenCalled();
  });

  it('never mails about preview deployments', async () => {
    mocks.findDeployment.mockResolvedValue({ ...deployment, isPreview: true });
    expect(await deploymentAlertService.handleDeploymentEvent('deployment.failed', project, { deploymentId: 'd2' })).toEqual({ sent: 0, kind: null });
    expect(mocks.sendFailed).not.toHaveBeenCalled();
  });

  it('ignores other events and events without a deployment', async () => {
    expect(await deploymentAlertService.handleDeploymentEvent('deployment.started', project, { deploymentId: 'd2' })).toEqual({ sent: 0, kind: null });
    expect(await deploymentAlertService.handleDeploymentEvent('deployment.failed', project, {})).toEqual({ sent: 0, kind: null });
    expect(mocks.findDeployment).not.toHaveBeenCalled();
  });

  it('sends nothing when everyone switched alerts off', async () => {
    mocks.findAlertRecipients.mockResolvedValue([]);
    expect(await deploymentAlertService.handleDeploymentEvent('deployment.failed', project, { deploymentId: 'd2' })).toEqual({ sent: 0, kind: 'failed' });
    expect(mocks.sendFailed).not.toHaveBeenCalled();
  });
});
