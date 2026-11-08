import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';

/**
 * Moving a project to another server: the move is a deploy on the target. Only when it succeeds
 * (healthy, nginx/SSL set up) does the project switch servers and are the source's containers
 * stopped — never removed. A failed deploy leaves the project where it was.
 */
const h = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  liveDeployment: { commitHash: 'abc1234', commitMessage: 'Ship it', branch: 'main' } as Record<string, unknown> | null,
  sourceServer: { id: 'srv-old', ipv4: '198.51.100.1', sshPrivateKey: 'enc-key' } as Record<string, unknown> | null,
  requireProjectMember: vi.fn(),
  updateProject: vi.fn(),
  createDeployment: vi.fn(),
  schedule: vi.fn(),
  log: vi.fn(),
  publish: vi.fn(async () => undefined),
  pause: vi.fn(async () => true),
  teardown: vi.fn(),
  syncDns: vi.fn(async () => [{ domain: 'app.example.com', status: 'updated' }]),
  disconnect: vi.fn(),
  connect: vi.fn(async () => undefined),
  copyVolumes: vi.fn(async (_source: unknown, _target: unknown, _options: { onStopping: (c: string[]) => void }) => undefined),
  restartOnSource: vi.fn(async () => true),
}));

vi.mock('../lib/org-access', () => ({ requireProjectMember: h.requireProjectMember }));
vi.mock('../db', () => ({
  db: {
    query: { servers: { findFirst: async () => h.sourceServer } },
    select: () => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => (h.liveDeployment ? [h.liveDeployment] : []) }) }) }),
    }),
  },
}));
vi.mock('../repositories/project.repository', () => ({
  projectRepository: { findById: async () => h.project, update: h.updateProject },
}));
vi.mock('../repositories/deployment.repository', () => ({ deploymentRepository: { create: h.createDeployment } }));
vi.mock('../repositories/database.repository', () => ({ databaseRepository: {} }));
vi.mock('../repositories/domain.repository', () => ({ domainRepository: {} }));
vi.mock('./activity.service', () => ({ activityService: { log: h.log } }));
vi.mock('./dns-provider.service', () => ({ dnsProviderService: {} }));
vi.mock('./plan-limits.service', () => ({ planLimitsService: {} }));
vi.mock('./organization-billing.service', () => ({ assertOrganizationCanMutateResources: vi.fn() }));
vi.mock('./preview.service', () => ({ isPublishedStaticSite: () => false }));
vi.mock('./domain.service', () => ({ domainService: { syncProjectDnsRecords: h.syncDns } }));
vi.mock('../lib/deployment-scheduler', () => ({ scheduleDeploymentProcessing: h.schedule }));
vi.mock('../lib/ws', () => ({ wsManager: { publish: h.publish } }));
vi.mock('../lib/encryption', () => ({ decrypt: (v: string) => `plain-${v}` }));
vi.mock('../utils/ssh', () => ({
  getSSHConnection: vi.fn(async () => ({ disconnect: h.disconnect })),
  SSHClient: class {
    connect = h.connect;
    disconnect = h.disconnect;
  },
}));
vi.mock('../lib/project-volume-transfer', () => ({
  copyVolumesToTarget: h.copyVolumes,
  restartOnSource: h.restartOnSource,
  measureVolumes: vi.fn(),
}));
vi.mock('../lib/project-remote-cleanup', () => ({
  pauseProjectContainersOnServer: h.pause,
  teardownProjectOnRemoteServer: h.teardown,
}));
vi.mock('../lib/project-containers', () => ({ projectContainerNames: async () => ({ workers: ['queue'] }) }));

import { projectTransferService } from './project-transfer.service';
import { getSSHConnection } from '../utils/ssh';

const transfer = { fromServerId: 'srv-old', toServerId: 'srv-new' };

const baseProject = () => ({
  id: 'project-1',
  organizationId: 'org-1',
  name: 'Yeli',
  slug: 'yeli',
  serverId: 'srv-old',
  status: 'active',
  gitBranch: 'main',
});

const preflight = (ok: boolean, blockers: string[] = []) => ({
  ok,
  fromServerId: 'srv-old',
  toServerId: 'srv-new',
  checks: [],
  blockers,
  dns: { targetIpv4: '203.0.113.9', targetIpv6: null, cloudflareConnected: false, domains: [] },
  volumes: { items: [], totalBytes: 0, requiredFreeBytes: null, targetFreeBytes: null, estimatedDowntimeSeconds: 0 },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  h.project = baseProject();
  h.sourceServer = { id: 'srv-old', ipv4: '198.51.100.1', sshPrivateKey: 'enc-key' };
  h.liveDeployment = { commitHash: 'abc1234', commitMessage: 'Ship it', branch: 'main' };
  h.requireProjectMember.mockResolvedValue({ membership: { role: 'member' }, project: baseProject() });
  h.createDeployment.mockResolvedValue({ id: 'dep-1' });
  h.updateProject.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({ ...h.project, ...data }));
  h.pause.mockResolvedValue(true);
  h.restartOnSource.mockResolvedValue(true);
  h.copyVolumes.mockResolvedValue(undefined);
});

describe('projectTransferService.start', () => {
  it('refuses a blocked move with the reasons and queues nothing', async () => {
    vi.spyOn(projectTransferService, 'evaluate').mockResolvedValue(
      preflight(false, ['The project has persistent volumes ("uploads") whose data stays on the current server.'])
    );

    const attempt = projectTransferService.start('project-1', 'org-1', 'user-1', 'srv-new');
    await expect(attempt).rejects.toBeInstanceOf(HTTPException);
    await expect(attempt).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/persistent volumes/) });
    expect(h.createDeployment).not.toHaveBeenCalled();
    expect(h.schedule).not.toHaveBeenCalled();
    expect(h.updateProject).not.toHaveBeenCalled();
  });

  it('requires member access to the project', async () => {
    h.requireProjectMember.mockRejectedValue(new HTTPException(403, { message: 'forbidden' }));
    await expect(projectTransferService.start('project-1', 'org-1', 'user-1', 'srv-new')).rejects.toMatchObject({ status: 403 });
    expect(h.requireProjectMember).toHaveBeenCalledWith('project-1', 'org-1', 'user-1', 'member', 'en');
  });

  it('queues the live commit for the target and leaves the project on its server', async () => {
    vi.spyOn(projectTransferService, 'evaluate').mockResolvedValue(preflight(true));

    const result = await projectTransferService.start('project-1', 'org-1', 'user-1', 'srv-new');

    expect(result.deploymentId).toBe('dep-1');
    expect(h.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        commitHash: 'abc1234',
        branch: 'main',
        environment: 'production',
        buildMetadata: { transfer },
      })
    );
    expect(h.schedule).toHaveBeenCalledWith('dep-1', 'project-1');
    expect(h.updateProject).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'project.transfer_started' }));
    expect(h.publish).toHaveBeenCalledWith('project:project-1', {
      type: 'project:transfer',
      data: expect.objectContaining({ status: 'started', ...transfer }),
    });
  });
});

describe('projectTransferService.complete (deploy healthy on the target)', () => {
  it('switches the project, stops — not removes — the source containers and syncs DNS', async () => {
    const ok = await projectTransferService.complete('dep-1', 'project-1', transfer);

    expect(ok).toBe(true);
    expect(h.updateProject).toHaveBeenCalledWith('project-1', { serverId: 'srv-new' });
    expect(getSSHConnection).toHaveBeenCalledWith(expect.objectContaining({ host: '198.51.100.1', privateKey: 'plain-enc-key' }));
    expect(h.pause).toHaveBeenCalledWith(expect.anything(), 'yeli', ['queue']);
    expect(h.teardown).not.toHaveBeenCalled();
    expect(h.disconnect).toHaveBeenCalled();
    expect(h.syncDns).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'srv-new' }));
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.transferred',
        changes: { serverId: { from: 'srv-old', to: 'srv-new' } },
        metadata: expect.objectContaining({ sourceStopped: true }),
      })
    );
    expect(h.publish).toHaveBeenCalledWith('project:project-1', {
      type: 'project:transfer',
      data: expect.objectContaining({ status: 'completed' }),
    });
  });

  it('still completes when the source cannot be reached, and says so', async () => {
    h.sourceServer = { id: 'srv-old', ipv4: null, sshPrivateKey: null };
    const ok = await projectTransferService.complete('dep-1', 'project-1', transfer);

    expect(ok).toBe(true);
    expect(h.updateProject).toHaveBeenCalledWith('project-1', { serverId: 'srv-new' });
    expect(h.pause).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.transferred', metadata: expect.objectContaining({ sourceStopped: false }) })
    );
  });

  it('does not move a project someone assigned elsewhere in the meantime', async () => {
    h.project = { ...baseProject(), serverId: 'srv-other' };
    const ok = await projectTransferService.complete('dep-1', 'project-1', transfer);

    expect(ok).toBe(false);
    expect(h.updateProject).not.toHaveBeenCalled();
    expect(h.pause).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'project.transfer_failed' }));
  });
});

describe('projectTransferService.fail (deploy on the target failed, e.g. health check)', () => {
  it('keeps the project on the source: no server change, nothing stopped, failure recorded', async () => {
    await projectTransferService.fail('dep-1', 'project-1', transfer, 'Container failed health check after 60s');

    expect(h.updateProject).not.toHaveBeenCalled();
    expect(h.pause).not.toHaveBeenCalled();
    expect(h.teardown).not.toHaveBeenCalled();
    expect(h.syncDns).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.transfer_failed',
        metadata: expect.objectContaining({ error: 'Container failed health check after 60s', ...transfer }),
      })
    );
    expect(h.publish).toHaveBeenCalledWith('project:project-1', {
      type: 'project:transfer',
      data: expect.objectContaining({ status: 'failed', message: 'Container failed health check after 60s' }),
    });
  });
});

describe('moving persistent volumes', () => {
  const stopped = ['pushify-yeli-blue'];

  it('copies from the source server into the target the deployer is connected to', async () => {
    const onLog = vi.fn();
    const step = projectTransferService.volumeStep(transfer, ['pushify-vol-yeli-uploads'], onLog);
    h.copyVolumes.mockImplementation(async (_source: unknown, _target: unknown, options: { onStopping: (c: string[]) => void }) => {
      options.onStopping(stopped);
    });
    const target = { exec: vi.fn() };

    await step.run(target as never);

    expect(h.connect).toHaveBeenCalledWith(expect.objectContaining({ host: '198.51.100.1', privateKey: 'plain-enc-key' }));
    expect(h.copyVolumes).toHaveBeenCalledWith(
      expect.anything(),
      target,
      expect.objectContaining({ names: ['pushify-vol-yeli-uploads'] })
    );
    expect(step.stoppedOnSource).toEqual(stopped);
    expect(h.disconnect).toHaveBeenCalled();
  });

  it('a failed step (copy, checksum, health check) starts the stopped containers again on the source', async () => {
    await projectTransferService.fail('dep-1', 'project-1', transfer, 'The copy of volume "pushify-vol-yeli-uploads" does not match', stopped);

    expect(h.restartOnSource).toHaveBeenCalledWith(expect.anything(), stopped);
    expect(h.updateProject).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.transfer_failed',
        metadata: expect.objectContaining({ sourceRestarted: true, stoppedOnSource: stopped }),
      })
    );
  });

  it('says so when the source could not be started again', async () => {
    h.restartOnSource.mockResolvedValue(false);
    await projectTransferService.fail('dep-1', 'project-1', transfer, 'Container failed health check', stopped);

    expect(h.publish).toHaveBeenCalledWith('project:project-1', {
      type: 'project:transfer',
      data: expect.objectContaining({ status: 'failed', message: expect.stringMatching(/start pushify-yeli-blue there by hand/) }),
    });
  });

  it('never restarts the source once the project runs on the target', async () => {
    h.project = { ...baseProject(), serverId: 'srv-new' };
    await projectTransferService.fail('dep-1', 'project-1', transfer, 'CDN purge failed', stopped);
    expect(h.restartOnSource).not.toHaveBeenCalled();
  });

  it('restarts nothing for a move without volumes', async () => {
    await projectTransferService.fail('dep-1', 'project-1', transfer, 'Build failed');
    expect(h.restartOnSource).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('restarts the source when the project was assigned elsewhere during the move', async () => {
    h.project = { ...baseProject(), serverId: 'srv-other' };
    expect(await projectTransferService.complete('dep-1', 'project-1', transfer, () => {}, stopped)).toBe(false);
    expect(h.restartOnSource).toHaveBeenCalledWith(expect.anything(), stopped);
  });
});
