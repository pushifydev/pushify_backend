import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/**
 * Zero-downtime guarantee for a cancelled deploy: cancelling only marks the deployment row
 * `cancelled`. Nothing connects to the server, so the live container keeps serving and nginx
 * keeps pointing at it — whether the deploy was still queued (the queue job then skips it) or
 * already building. The other two ways a deploy ends early, a failed build and a new container
 * that crashes or never passes its health check, are covered in remote-deployment-failure.test.ts
 * and blue-green-deploy.test.ts.
 */

const LIVE = 'pushify-shop-blue';
const LIVE_UPSTREAM = '127.0.0.1:5123';

const h = vi.hoisted(() => ({
  deployment: { id: 'dep-12345678', projectId: 'proj-1', serverId: 'srv-1', status: 'building' },
  /** The deploy server: what runs on it and where nginx sends the project's traffic */
  host: { containers: new Map<string, 'running' | 'stopped' | 'removed'>(), upstream: '' },
  sshConnects: 0,
  commands: [] as string[],
  uploads: [] as string[],
  updateStatus: vi.fn(async (id: string, status: string) => ({ id, status })),
  executeDeploymentJob: vi.fn(async () => undefined),
  processor: null as null | ((job: { id: string; data: { deploymentId: string } }) => Promise<void>),
}));

vi.mock('../utils/ssh', () => ({
  SSHClient: class {
    async connect() {
      h.sshConnects++;
    }
    disconnect() {}
    async exec(command: string) {
      h.commands.push(command);
      for (const [name] of h.host.containers) {
        if (new RegExp(`docker (rm|kill)\\b[^\\n]*\\b${name}\\b`).test(command)) h.host.containers.set(name, 'removed');
        else if (new RegExp(`docker stop\\b[^\\n]*\\b${name}\\b`).test(command)) h.host.containers.set(name, 'stopped');
      }
      if (/nginx -s reload|systemctl (reload|restart) nginx/.test(command)) h.host.upstream = 'reloaded';
      return { code: 0, stdout: '', stderr: '' };
    }
    async uploadFile(_content: string | Buffer, remotePath: string) {
      h.uploads.push(remotePath);
      if (remotePath.startsWith('/etc/nginx')) h.host.upstream = 'rewritten';
    }
  },
}));

vi.mock('./nginx-manager', () => ({
  addAutoSubdomainSite: vi.fn(async () => ({ success: true, message: '' })),
  reloadNginx: vi.fn(async () => ({ success: true, message: '' })),
}));

// deploymentService.cancel
vi.mock('../db', () => ({ db: {} }));
vi.mock('../repositories/deployment.repository', () => ({
  deploymentRepository: { findById: async () => ({ ...h.deployment }), updateStatus: h.updateStatus },
}));
vi.mock('../repositories/project.repository', () => ({
  projectRepository: { findById: async () => ({ id: 'proj-1', organizationId: 'org-1', slug: 'shop', status: 'active' }) },
}));
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: { findMember: async () => ({ role: 'member', restrictedAccess: false }) },
}));
vi.mock('../lib/member-project-scope', () => ({ assertMemberProjectScope: async () => undefined }));
vi.mock('../services/organization-billing.service', () => ({ assertOrganizationCanMutateResources: vi.fn() }));
vi.mock('../services/plan-limits.service', () => ({ planLimitsService: {} }));

// The deployment queue worker
vi.mock('../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('bullmq', () => ({
  Worker: class {
    constructor(_queue: string, processor: NonNullable<typeof h.processor>) {
      h.processor = processor;
    }
    on() {
      return this;
    }
    async close() {}
  },
}));
vi.mock('../lib/redis-connection', () => ({ getBullRedisConnection: () => ({}) }));
vi.mock('../lib/deploy-concurrency', () => ({
  tryAcquireDeploySlots: vi.fn(async () => true),
  releaseDeploySlots: vi.fn(async () => undefined),
}));
vi.mock('../lib/deploy-worker-lock', () => ({ tryHoldDeployWorkerLeadership: vi.fn(async () => false) }));
vi.mock('../lib/deployment-scheduler', () => ({ scheduleDeploymentProcessing: vi.fn(async () => undefined) }));
vi.mock('./deployment.worker', () => ({
  loadDeploymentJobById: vi.fn(async () => ({ ...h.deployment })),
  executeDeploymentJob: h.executeDeploymentJob,
  refreshPendingDeploymentQueueLogs: vi.fn(async () => undefined),
}));

const { deploymentService } = await import('../services/deployment.service');
const { startDeploymentQueueWorker, stopDeploymentQueueWorker } = await import('./deployment-queue.worker');
const { addAutoSubdomainSite, reloadNginx } = await import('./nginx-manager');

function expectLiveUntouched() {
  expect(h.host.containers.get(LIVE)).toBe('running');
  expect(h.host.upstream).toBe(LIVE_UPSTREAM);
  expect(h.sshConnects).toBe(0);
  expect(h.commands).toEqual([]);
  expect(h.uploads).toEqual([]);
  expect(reloadNginx).not.toHaveBeenCalled();
  expect(addAutoSubdomainSite).not.toHaveBeenCalled();
}

beforeEach(() => {
  h.host.containers = new Map([[LIVE, 'running']]);
  h.host.upstream = LIVE_UPSTREAM;
  h.sshConnects = 0;
  h.commands = [];
  h.uploads = [];
  vi.clearAllMocks();
});

afterAll(async () => {
  await stopDeploymentQueueWorker();
});

describe('a cancelled deploy leaves the live container serving', () => {
  it.each(['pending', 'building', 'deploying'])(
    'cancelled while %s: only the row is marked cancelled, live container and nginx untouched',
    async (status) => {
      h.deployment.status = status;

      await deploymentService.cancel('dep-12345678', 'proj-1', 'org-1', 'user-1', 'en');

      expect(h.updateStatus).toHaveBeenCalledWith('dep-12345678', 'cancelled');
      expectLiveUntouched();
    }
  );

  it('cancelled before the worker picked it up: the queued job never starts the deploy', async () => {
    startDeploymentQueueWorker();
    expect(h.processor).not.toBeNull();
    const job = { id: 'job-1', data: { deploymentId: 'dep-12345678' } };

    // Control: a deploy that is still pending is handed to the deploy pipeline
    h.deployment.status = 'pending';
    await h.processor!(job);
    expect(h.executeDeploymentJob).toHaveBeenCalledOnce();

    h.executeDeploymentJob.mockClear();
    h.deployment.status = 'cancelled';
    await h.processor!(job);

    expect(h.executeDeploymentJob).not.toHaveBeenCalled();
    expectLiveUntouched();
  });
});
