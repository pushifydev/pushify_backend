import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  disk: [] as number[],
  cleanupCalls: 0,
  emails: [] as Array<Record<string, unknown>>,
  info: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => h.rows }) }),
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { h.updates.push(v); } }) }),
  },
}));
vi.mock('../utils/ssh', () => ({ getSSHConnection: async () => ({}) }));
vi.mock('../lib/encryption', () => ({ decrypt: (s: string) => s }));
vi.mock('../lib/server-disk-check', () => ({
  checkServerDiskSpace: async () => {
    const usedPercent = h.disk.shift() ?? 0;
    return { usedPercent, availGb: 5, mount: '/', measured: true, warn: usedPercent >= 85, critical: usedPercent >= 95, ok: true, message: '' };
  },
}));
vi.mock('../lib/server-disk-cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-disk-cleanup')>()),
  runServerDiskCleanup: async () => {
    h.cleanupCalls++;
    return {
      ran: true, freedBytes: 7e9, logsTruncatedBytes: 6e9, daemonConfig: 'created', volumesBytes: 20e9,
      imagesBytes: 3e9, buildCacheBytes: 0, containersBytes: 0, logsBytes: 1e8,
      uncappedLogContainers: 4, rotatedLogContainers: 2, usedBytes: 30e9, totalBytes: 38e9,
    };
  },
}));
vi.mock('../lib/email', () => ({ sendServerDiskEmail: async (_to: string, d: Record<string, unknown>) => { h.emails.push(d); } }));
vi.mock('../repositories/organization.repository', () => ({ organizationRepository: { findById: async () => ({ name: 'Org' }) } }));
vi.mock('../repositories/deployment-alert.repository', () => ({
  deploymentAlertRepository: { findAlertRecipients: async () => [{ email: 'a@b.c' }] },
}));
vi.mock('./admin-notify.service', () => ({ adminNotify: () => {} }));
vi.mock('../lib/logger', () => ({ logger: { info: h.info, warn: () => {}, error: () => {}, debug: () => {} } }));

import { serverDiskService } from './server-disk.service';

const server = (over: Record<string, unknown> = {}) => ({
  id: 's1', name: 'srv', organizationId: 'o1', ipv4: '1.2.3.4', sshPrivateKey: 'k',
  isManaged: true, diskNotifiedAt: null, ...over,
});

beforeEach(() => {
  h.rows = []; h.updates = []; h.disk = []; h.cleanupCalls = 0; h.emails = []; h.info.mockClear();
});

describe('serverDiskService.checkAll cleanup', () => {
  it('cleans a managed server over the threshold, logs what it freed and judges the disk afterwards', async () => {
    h.rows = [server()];
    h.disk = [86, 72];
    const res = await serverDiskService.checkAll(new Date('2026-10-15T00:00:00Z'));
    expect(res).toEqual({ checked: 1, warned: 0, cleaned: 1 });
    expect(h.cleanupCalls).toBe(1);
    expect(h.info).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 's1', freedBytes: 7e9, logsTruncatedBytes: 6e9, usedPercentBefore: 86, usedPercentAfter: 72,
      }),
      'Server disk cleanup finished'
    );
    expect(h.updates[0]).toMatchObject({ diskUsedPercent: 72 });
    expect(h.emails).toHaveLength(0);
  });

  it('records what holds the disk on the server, labelled as user data when volumes dominate', async () => {
    h.rows = [server()];
    h.disk = [86, 86];
    await serverDiskService.checkAll(new Date('2026-10-15T00:00:00Z'));
    expect(h.updates[0].diskBreakdown).toMatchObject({
      measuredAt: '2026-10-15T00:00:00.000Z',
      heldBy: 'volumes',
      userData: true,
      volumesBytes: 20e9,
      imagesBytes: 3e9,
      logsBytes: 1e8,
      uncappedLogContainers: 4,
      cleanup: { freedBytes: 7e9, rotatedLogContainers: 2 },
    });
  });

  it('does not overwrite the breakdown when no cleanup ran', async () => {
    h.rows = [server()];
    h.disk = [50];
    await serverDiskService.checkAll();
    expect(h.updates[0]).not.toHaveProperty('diskBreakdown');
  });

  it('when cleanup is not enough, tells the customer it is their data and to resize', async () => {
    h.rows = [server()];
    h.disk = [90, 88];
    const res = await serverDiskService.checkAll(new Date('2026-10-15T00:00:00Z'));
    expect(res.warned).toBe(1);
    expect(h.emails[0]).toMatchObject({ usedPercent: 88, dataGb: 20 });
  });

  it('leaves bring-your-own servers and servers under the threshold alone', async () => {
    h.rows = [server({ isManaged: false }), server({ id: 's2' })];
    h.disk = [90, 50];
    const res = await serverDiskService.checkAll();
    expect(h.cleanupCalls).toBe(0);
    expect(res.cleaned).toBe(0);
    expect(h.emails[0]).toMatchObject({ usedPercent: 90, dataGb: undefined });
  });
});
