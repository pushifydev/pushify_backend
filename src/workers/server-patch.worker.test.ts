import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';

/**
 * The server-patches worker: holds the per-server lock for the whole run, writes the outcome to the
 * audit log (which the server timeline reads) and gives the lock back however the run ends.
 */
const { h } = vi.hoisted(() => ({
  h: {
    server: null as Record<string, unknown> | null,
    lockFree: true,
    released: [] as string[],
    audit: [] as Array<Record<string, unknown>>,
    connected: [] as Array<Record<string, unknown>>,
    disconnected: 0,
    apply: null as null | (() => Promise<unknown>),
    lockTokens: [] as string[],
    lastAutoPatch: [] as Array<Record<string, unknown>>,
    deployInProgress: false,
    deferred: [] as Array<{ data: Record<string, unknown>; opts: Record<string, unknown> }>,
    schedulesRemoved: [] as string[],
  },
}));

vi.mock('../db', () => {
  const chain = { from: () => chain, where: () => chain, limit: async () => (h.server ? [h.server] : []) };
  return {
    db: {
      select: () => chain,
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            h.lastAutoPatch.push(values.lastAutoPatch as Record<string, unknown>);
          },
        }),
      }),
    },
  };
});
vi.mock('../lib/encryption', () => ({ decrypt: (v: string) => `decrypted(${v})` }));
vi.mock('../lib/server-patch-lock', () => ({
  acquireServerPatchLock: async (_serverId: string, token: string) => {
    h.lockTokens.push(token);
    return h.lockFree;
  },
  releaseServerPatchLock: async (_serverId: string, token: string) => {
    h.released.push(token);
  },
}));
vi.mock('../utils/ssh', () => ({
  SSHClient: class {
    async connect(config: Record<string, unknown>) {
      h.connected.push(config);
    }
    disconnect() {
      h.disconnected++;
    }
  },
}));
vi.mock('../lib/server-patch-apply', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/server-patch-apply')>();
  return { ...actual, applySecurityPatches: async () => h.apply!() };
});
vi.mock('../lib/server-auto-patch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/server-auto-patch')>();
  return {
    ...actual,
    hasDeployInProgress: async () => h.deployInProgress,
    removeServerAutoPatchSchedule: async (serverId: string) => {
      h.schedulesRemoved.push(serverId);
    },
  };
});
vi.mock('../lib/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queue')>();
  return {
    ...actual,
    addServerPatchJob: async (data: Record<string, unknown>, opts: Record<string, unknown>) => {
      h.deferred.push({ data, opts });
      return { id: `retry-${h.deferred.length}` };
    },
  };
});
vi.mock('../services/activity.service', () => ({
  activityService: {
    log: async (input: Record<string, unknown>) => {
      h.audit.push(input);
    },
  },
}));

import { processServerPatchJob } from './server-patch.worker';
import { PatchApplyError } from '../lib/server-patch-apply';
import { AUTO_PATCH_DEFER_MS } from '../lib/server-auto-patch';
import type { ServerPatchJobData } from '../lib/queue';

const job = {
  id: 'job-7',
  data: { serverId: 's-1', organizationId: 'org-1', requestedBy: 'u-admin', lockToken: 'tok-1' },
} as Job<ServerPatchJobData>;

const RESULT = {
  os: 'ubuntu',
  packageManager: 'apt' as const,
  packages: ['libssl3'],
  excluded: ['containerd'],
  remaining: { pending: 3, security: 0 },
  rebootRequired: true,
  output: 'Setting up libssl3 ...',
  notes: [],
};

beforeEach(() => {
  h.server = { id: 's-1', name: 'web-1', ipv4: '203.0.113.10', sshPrivateKey: 'enc' };
  h.lockFree = true;
  h.released = [];
  h.audit = [];
  h.connected = [];
  h.disconnected = 0;
  h.apply = async () => RESULT;
  h.lockTokens = [];
  h.lastAutoPatch = [];
  h.deployInProgress = false;
  h.deferred = [];
  h.schedulesRemoved = [];
});

describe('processServerPatchJob', () => {
  it('records the run on the audit log with output, updates left and reboot required, then releases the lock', async () => {
    const res = await processServerPatchJob(job);
    const summary = 'Installed 1 security update (apt); skipped containerd (Docker/containerd); 0 security / 3 total updates left; reboot required';
    expect(res).toMatchObject({ status: 'applied', summary, rebootRequired: true, remaining: { pending: 3, security: 0 } });
    expect(h.connected).toEqual([{ host: '203.0.113.10', port: 22, username: 'root', privateKey: 'decrypted(enc)' }]);
    expect(h.audit).toEqual([
      {
        organizationId: 'org-1',
        action: 'server.patches_applied',
        description: `Server "web-1": ${summary}`,
        metadata: { serverId: 's-1', serverName: 'web-1', requestedBy: 'u-admin', jobId: 'job-7', trigger: 'manual', summary, ...RESULT },
      },
    ]);
    expect(h.disconnected).toBe(1);
    expect(h.released).toEqual(['tok-1']);
  });

  it('a failed run is recorded with its code and output, the job fails and the lock is released', async () => {
    h.apply = async () => {
      throw new PatchApplyError('UNSUPPORTED_OS', 'Unsupported OS "alpine"', 'some output');
    };
    await expect(processServerPatchJob(job)).rejects.toThrow('Unsupported OS "alpine"');
    expect(h.audit).toEqual([
      expect.objectContaining({
        action: 'server.patches_failed',
        metadata: expect.objectContaining({ serverId: 's-1', code: 'UNSUPPORTED_OS', error: 'Unsupported OS "alpine"', output: 'some output' }),
      }),
    ]);
    expect(h.released).toEqual(['tok-1']);
  });

  it('does nothing while another run holds the lock', async () => {
    h.lockFree = false;
    expect(await processServerPatchJob(job)).toEqual({ status: 'skipped', reason: 'locked' });
    expect(h.connected).toEqual([]);
    expect(h.audit).toEqual([]);
    expect(h.released).toEqual([]);
  });

  it('a deleted server ends the job quietly and releases the lock', async () => {
    h.server = null;
    expect(await processServerPatchJob(job)).toEqual({ status: 'skipped', reason: 'server_deleted' });
    expect(h.released).toEqual(['tok-1']);
  });
});

/**
 * Scheduled runs (trigger 'auto', from the server's job scheduler): the same worker and apply
 * function, gated by the setting, the maintenance window and deploys going on on the server.
 */
describe('processServerPatchJob: scheduled runs', () => {
  const autoJob = {
    id: 'repeat:auto-patch-s-1:1794106800000',
    data: { serverId: 's-1', organizationId: 'org-1', requestedBy: null, trigger: 'auto' },
  } as Job<ServerPatchJobData>;

  /** Daily at 03:00 UTC unless overridden */
  function scheduledServer(overrides: Record<string, unknown> = {}) {
    h.server = {
      id: 's-1',
      name: 'web-1',
      ipv4: '203.0.113.10',
      sshPrivateKey: 'enc',
      status: 'running',
      setupStatus: 'completed',
      autoPatch: 'daily',
      autoPatchHour: 3,
      autoPatchWeekday: 0,
      ...overrides,
    };
  }

  function at(iso: string) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('setting on, inside the window, no deploy: applies, audits as automatic, keeps the outcome on the server', async () => {
    scheduledServer();
    at('2026-11-08T03:02:00Z');
    const res = await processServerPatchJob(autoJob);
    expect(res).toMatchObject({ status: 'applied', rebootRequired: true });
    expect(h.connected).toHaveLength(1);
    // No lock was queued with it: the worker took one and gave it back
    expect(h.lockTokens).toHaveLength(1);
    expect(h.released).toEqual(h.lockTokens);
    expect(h.audit).toEqual([
      expect.objectContaining({
        action: 'server.patches_applied',
        description: expect.stringMatching(/^Server "web-1" \(automatic\): Installed 1 security update/),
        metadata: expect.objectContaining({ serverId: 's-1', requestedBy: null, trigger: 'auto' }),
      }),
    ]);
    expect(h.lastAutoPatch).toEqual([
      {
        at: expect.any(String),
        status: 'applied',
        packagesApplied: 1,
        rebootRequired: true,
        summary: expect.stringContaining('Installed 1 security update'),
        error: null,
        code: null,
      },
    ]);
    expect(h.deferred).toEqual([]);
  });

  it('weekly on its day runs; dnf runs keep packagesApplied null', async () => {
    scheduledServer({ autoPatch: 'weekly', autoPatchHour: 22, autoPatchWeekday: 0 });
    at('2026-11-08T22:59:00Z'); // a Sunday
    h.apply = async () => ({ ...RESULT, packageManager: 'dnf', packages: [], excluded: [], rebootRequired: false });
    expect(await processServerPatchJob(autoJob)).toMatchObject({ status: 'applied' });
    expect(h.lastAutoPatch).toEqual([expect.objectContaining({ status: 'applied', packagesApplied: null, rebootRequired: false })]);
  });

  it('setting off: nothing runs and the schedule is removed', async () => {
    scheduledServer({ autoPatch: 'off' });
    at('2026-11-08T03:02:00Z');
    expect(await processServerPatchJob(autoJob)).toEqual({ status: 'skipped', reason: 'disabled' });
    expect(h.schedulesRemoved).toEqual(['s-1']);
    expect(h.lockTokens).toEqual([]);
    expect(h.connected).toEqual([]);
    expect(h.audit).toEqual([]);
    expect(h.lastAutoPatch).toEqual([]);
  });

  it('a deleted server: nothing runs and the schedule is removed', async () => {
    h.server = null;
    expect(await processServerPatchJob(autoJob)).toEqual({ status: 'skipped', reason: 'server_deleted' });
    expect(h.schedulesRemoved).toEqual(['s-1']);
    expect(h.connected).toEqual([]);
  });

  it.each([
    ['before the window', { autoPatch: 'daily' }, '2026-11-08T02:59:59Z'],
    ['after the window', { autoPatch: 'daily' }, '2026-11-08T04:00:00Z'],
    ['weekly on another day', { autoPatch: 'weekly', autoPatchWeekday: 1 }, '2026-11-08T03:02:00Z'],
  ])('outside the maintenance window (%s): nothing runs', async (_label, overrides, now) => {
    scheduledServer(overrides);
    at(now);
    expect(await processServerPatchJob(autoJob)).toEqual({ status: 'skipped', reason: 'outside_window' });
    expect(h.lockTokens).toEqual([]);
    expect(h.connected).toEqual([]);
    expect(h.audit).toEqual([]);
    expect(h.lastAutoPatch).toEqual([]);
  });

  it('a server that is not running: nothing runs', async () => {
    scheduledServer({ status: 'stopped' });
    at('2026-11-08T03:02:00Z');
    expect(await processServerPatchJob(autoJob)).toEqual({ status: 'skipped', reason: 'server_not_ready' });
    expect(h.connected).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('a deploy going on: the run is put off inside the window, nothing touches the server', async () => {
    scheduledServer();
    h.deployInProgress = true;
    at('2026-11-08T03:02:00Z');
    expect(await processServerPatchJob(autoJob)).toEqual({ status: 'deferred', until: '2026-11-08T03:12:00.000Z' });
    expect(h.deferred).toEqual([
      { data: { ...autoJob.data, deferrals: 1 }, opts: { delay: AUTO_PATCH_DEFER_MS } },
    ]);
    expect(h.lockTokens).toEqual([]);
    expect(h.connected).toEqual([]);
    expect(h.audit).toEqual([]);
    expect(h.lastAutoPatch).toEqual([]);
  });

  it('a deploy still going on when the window ends: skipped, audited and kept on the server', async () => {
    scheduledServer();
    h.deployInProgress = true;
    at('2026-11-08T03:52:00Z');
    const job = { ...autoJob, data: { ...autoJob.data, deferrals: 5 } } as Job<ServerPatchJobData>;
    expect(await processServerPatchJob(job)).toEqual({ status: 'skipped', reason: 'deploy_in_progress' });
    expect(h.deferred).toEqual([]);
    expect(h.connected).toEqual([]);
    expect(h.audit).toEqual([
      expect.objectContaining({
        action: 'server.patches_skipped',
        metadata: expect.objectContaining({ serverId: 's-1', trigger: 'auto', code: 'DEPLOY_IN_PROGRESS', deferrals: 5 }),
      }),
    ]);
    expect(h.lastAutoPatch).toEqual([
      expect.objectContaining({ status: 'skipped', code: 'DEPLOY_IN_PROGRESS', packagesApplied: null, rebootRequired: null }),
    ]);
  });

  it('a failed scheduled run keeps its error on the server and releases the lock', async () => {
    scheduledServer();
    at('2026-11-08T03:02:00Z');
    h.apply = async () => {
      throw new PatchApplyError('DOCKER_DEPENDENCY', 'Nothing was installed: these updates would also upgrade containerd');
    };
    await expect(processServerPatchJob(autoJob)).rejects.toThrow('Nothing was installed');
    expect(h.audit).toEqual([
      expect.objectContaining({ action: 'server.patches_failed', metadata: expect.objectContaining({ trigger: 'auto' }) }),
    ]);
    expect(h.lastAutoPatch).toEqual([
      expect.objectContaining({
        status: 'failed',
        code: 'DOCKER_DEPENDENCY',
        error: 'Nothing was installed: these updates would also upgrade containerd',
      }),
    ]);
    expect(h.released).toEqual(h.lockTokens);
  });

  it('a manual run holding the lock wins: the scheduled run does nothing', async () => {
    scheduledServer();
    at('2026-11-08T03:02:00Z');
    h.lockFree = false;
    expect(await processServerPatchJob(autoJob)).toEqual({ status: 'skipped', reason: 'locked' });
    expect(h.connected).toEqual([]);
    expect(h.lastAutoPatch).toEqual([]);
  });
});
