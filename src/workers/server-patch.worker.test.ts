import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  },
}));

vi.mock('../db', () => {
  const chain = { from: () => chain, where: () => chain, limit: async () => (h.server ? [h.server] : []) };
  return { db: { select: () => chain } };
});
vi.mock('../lib/encryption', () => ({ decrypt: (v: string) => `decrypted(${v})` }));
vi.mock('../lib/server-patch-lock', () => ({
  acquireServerPatchLock: async () => h.lockFree,
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
vi.mock('../services/activity.service', () => ({
  activityService: {
    log: async (input: Record<string, unknown>) => {
      h.audit.push(input);
    },
  },
}));

import { processServerPatchJob } from './server-patch.worker';
import { PatchApplyError } from '../lib/server-patch-apply';
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
        metadata: { serverId: 's-1', serverName: 'web-1', requestedBy: 'u-admin', jobId: 'job-7', summary, ...RESULT },
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
