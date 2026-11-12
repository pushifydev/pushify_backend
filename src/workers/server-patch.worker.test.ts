import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
    notified: [] as Array<Record<string, unknown>>,
    alerts: [] as Array<{ server: Record<string, unknown>; alert: string; run: Record<string, unknown> }>,
    alertFails: false,
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
            h.notified.push(values.autoPatchNotified as Record<string, unknown>);
            // What the next run reads back
            if (h.server) h.server.autoPatchNotified = values.autoPatchNotified;
          },
        }),
      }),
    },
  };
});
vi.mock('../services/server-auto-patch-alert.service', () => ({
  serverAutoPatchAlertService: {
    announce: async (server: Record<string, unknown>, alert: string, run: Record<string, unknown>) => {
      if (h.alertFails) throw new Error('smtp down');
      h.alerts.push({ server, alert, run });
    },
  },
}));
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
  h.notified = [];
  h.alerts = [];
  h.alertFails = false;
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
    // Asked for by hand: the caller sees the outcome, nothing is emailed or kept as scheduled state
    expect(h.alerts).toEqual([]);
    expect(h.notified).toEqual([]);
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
    expect(h.alerts).toEqual([]);
  });
});

/**
 * Emails from scheduled runs: only a failure or a pending reboot, each condition once. Every run is
 * still on the timeline and in lastAutoPatch.
 */
describe('processServerPatchJob: scheduled run alerts', () => {
  const autoJob = {
    id: 'repeat:auto-patch-s-1:1794106800000',
    data: { serverId: 's-1', organizationId: 'org-1', requestedBy: null, trigger: 'auto' },
  } as Job<ServerPatchJobData>;

  beforeEach(() => {
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
      autoPatchNotified: null,
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T03:02:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a reboot left pending is emailed once; the next runs with it still pending are not', async () => {
    await processServerPatchJob(autoJob);
    expect(h.alerts).toEqual([
      {
        server: { id: 's-1', name: 'web-1', organizationId: 'org-1' },
        alert: 'reboot_required',
        run: expect.objectContaining({ status: 'applied', rebootRequired: true }),
      },
    ]);
    expect(h.notified).toEqual([{ failureCode: null, rebootRequired: true }]);

    await processServerPatchJob(autoJob);
    await processServerPatchJob(autoJob);
    expect(h.alerts).toHaveLength(1);
    expect(h.lastAutoPatch).toHaveLength(3);
    expect(h.audit.filter((entry) => entry.action === 'server.patches_applied')).toHaveLength(3);
  });

  it('a run that no longer needs a reboot re-arms it', async () => {
    h.server!.autoPatchNotified = { failureCode: null, rebootRequired: true };
    h.apply = async () => ({ ...RESULT, rebootRequired: false });
    await processServerPatchJob(autoJob);
    expect(h.alerts).toEqual([]);
    expect(h.notified).toEqual([{ failureCode: null, rebootRequired: false }]);

    h.apply = async () => RESULT;
    await processServerPatchJob(autoJob);
    expect(h.alerts.map((a) => a.alert)).toEqual(['reboot_required']);
  });

  it('a failure is emailed once; the same failure again is not; after a clean run it is again', async () => {
    h.apply = async () => {
      throw new PatchApplyError('DOCKER_DEPENDENCY', 'Nothing was installed: these updates would also upgrade containerd');
    };
    await expect(processServerPatchJob(autoJob)).rejects.toThrow('Nothing was installed');
    expect(h.alerts).toEqual([
      {
        server: { id: 's-1', name: 'web-1', organizationId: 'org-1' },
        alert: 'failed',
        run: expect.objectContaining({ status: 'failed', code: 'DOCKER_DEPENDENCY', error: expect.stringContaining('containerd') }),
      },
    ]);
    await expect(processServerPatchJob(autoJob)).rejects.toThrow('Nothing was installed');
    expect(h.alerts).toHaveLength(1);
    expect(h.audit.filter((entry) => entry.action === 'server.patches_failed')).toHaveLength(2);

    h.apply = async () => ({ ...RESULT, rebootRequired: false });
    await processServerPatchJob(autoJob);
    expect(h.alerts).toHaveLength(1);

    h.apply = async () => {
      throw new PatchApplyError('DOCKER_DEPENDENCY', 'Nothing was installed');
    };
    await expect(processServerPatchJob(autoJob)).rejects.toThrow('Nothing was installed');
    expect(h.alerts.map((a) => a.alert)).toEqual(['failed', 'failed']);
  });

  it('a clean run and a run skipped for a deploy send nothing', async () => {
    h.apply = async () => ({ ...RESULT, rebootRequired: false });
    await processServerPatchJob(autoJob);

    h.deployInProgress = true;
    vi.setSystemTime(new Date('2026-11-08T03:52:00Z'));
    expect(await processServerPatchJob(autoJob)).toEqual({ status: 'skipped', reason: 'deploy_in_progress' });

    expect(h.lastAutoPatch.map((run) => run.status)).toEqual(['applied', 'skipped']);
    expect(h.alerts).toEqual([]);
  });

  it('an email that cannot be sent does not change the run', async () => {
    h.alertFails = true;
    expect(await processServerPatchJob(autoJob)).toMatchObject({ status: 'applied', rebootRequired: true });
    expect(h.lastAutoPatch).toHaveLength(1);
    expect(h.released).toEqual(h.lockTokens);
  });
});

describe('migration 0098', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../db/migrations/0098_server_auto_patch_notified.sql', import.meta.url)),
    'utf8'
  );

  it('adds the nullable alert state column, additively, and is in the journal', () => {
    expect(sql).toContain('ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "auto_patch_notified" jsonb;');
    expect(sql).not.toMatch(/\bDROP\b|NOT NULL/i);
    const journal = JSON.parse(
      readFileSync(fileURLToPath(new URL('../db/migrations/meta/_journal.json', import.meta.url)), 'utf8')
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.map((entry) => entry.tag)).toContain('0098_server_auto_patch_notified');
  });
});
