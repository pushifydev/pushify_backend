import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  disk: [] as number[],
  cleanupCalls: 0,
  cleanupRan: true,
  lockFree: true,
  lockReleases: 0,
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
vi.mock('../lib/server-disk-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-disk-check')>()),
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
      ran: h.cleanupRan, freedBytes: 7e9, logsTruncatedBytes: 6e9, daemonConfig: 'created', volumesBytes: 20e9,
      imagesBytes: 3e9, buildCacheBytes: 0, containersBytes: 0, logsBytes: 1e8,
      uncappedLogContainers: 4, rotatedLogContainers: 2, usedBytes: 30e9, totalBytes: 38e9,
    };
  },
}));
vi.mock('../lib/server-disk-cleanup-lock', () => ({
  acquireServerDiskCleanupLock: async () => h.lockFree,
  releaseServerDiskCleanupLock: async () => { h.lockReleases++; },
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
  isManaged: true, diskNotifiedAt: null, diskAlertPercent: null, ...over,
});

beforeEach(() => {
  h.rows = []; h.updates = []; h.disk = []; h.cleanupCalls = 0; h.cleanupRan = true; h.emails = []; h.info.mockClear();
  h.lockFree = true; h.lockReleases = 0;
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
        serverId: 's1',
        freedBytes: 7e9,
        logsTruncatedBytes: 6e9,
        usedPercentBefore: 86,
        usedPercentAfter: 72,
      }),
      'Server disk cleanup finished'
    );
    expect(h.updates[0]).toMatchObject({ diskUsedPercent: 72 });
    expect(h.emails).toHaveLength(0);
  });

  it('logs no after-percent when the cleanup did not run, and keeps the first reading', async () => {
    h.rows = [server()];
    h.disk = [86, 10];
    h.cleanupRan = false;
    await serverDiskService.checkAll(new Date('2026-10-15T00:00:00Z'));
    expect(h.info).toHaveBeenCalledWith(
      expect.objectContaining({ ran: false, usedPercentBefore: 86, usedPercentAfter: null }),
      'Server disk cleanup finished'
    );
    expect(h.updates[0]).toMatchObject({ diskUsedPercent: 86 });
    expect(h.updates[0]).not.toHaveProperty('diskBreakdown');
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

  it('releases the cleanup lock after cleaning', async () => {
    h.rows = [server()];
    h.disk = [86, 72];
    await serverDiskService.checkAll();
    expect(h.cleanupCalls).toBe(1);
    expect(h.lockReleases).toBe(1);
  });

  it('skips the cleanup while another one (a deploy’s) holds the server lock', async () => {
    h.rows = [server()];
    h.disk = [86];
    h.lockFree = false;
    const res = await serverDiskService.checkAll();
    expect(h.cleanupCalls).toBe(0);
    expect(res).toMatchObject({ checked: 1, cleaned: 0 });
    expect(h.updates[0]).toMatchObject({ diskUsedPercent: 86 });
  });
});

describe('serverDiskService.checkAll alerts: one per crossing of the threshold', () => {
  const HOUR = 60 * 60 * 1000;
  const start = new Date('2026-11-11T00:00:00Z').getTime();

  /** One hourly run per reading, carrying what the run stored into the next one, as the database does. */
  async function hourly(row: Record<string, unknown>, readings: number[]): Promise<number[]> {
    h.rows = [row];
    const warned: number[] = [];
    for (const [i, reading] of readings.entries()) {
      h.disk = [reading];
      h.updates = [];
      const res = await serverDiskService.checkAll(new Date(start + i * HOUR));
      warned.push(res.warned);
      Object.assign(row, h.updates[0]);
    }
    return warned;
  }

  it('sends one alert on the first crossing, with the free GB and where deploys stop', async () => {
    const row = server({ isManaged: false });
    expect(await hourly(row, [80, 86])).toEqual([0, 1]);
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]).toMatchObject({
      serverId: 's1',
      usedPercent: 86,
      availGb: 5,
      alertPercent: 85,
      deployBlockPercent: 90,
      deployMinFreeGb: 2,
    });
    expect(row.diskNotifiedAt).toEqual(new Date(start + HOUR));
  });

  it('sends nothing more while the disk stays high, however long and however full', async () => {
    const row = server({ isManaged: false });
    // Two days over the line, past where the old daily reminder fired, and up to 97%
    const readings = [86, ...Array.from({ length: 47 }, (_, i) => 86 + (i % 12))];
    const warned = await hourly(row, readings);
    expect(warned.reduce((a, b) => a + b, 0)).toBe(1);
    expect(h.emails).toHaveLength(1);
  });

  it('does not re-arm while usage is under the threshold but within 5 points of it', async () => {
    const row = server({ isManaged: false });
    expect(await hourly(row, [86, 84, 81, 86, 88])).toEqual([1, 0, 0, 0, 0]);
    expect(h.emails).toHaveLength(1);
    expect(row.diskNotifiedAt).not.toBeNull();
  });

  it('sends a new alert after the disk falls 5 points under the threshold and crosses it again', async () => {
    const row = server({ isManaged: false });
    expect(await hourly(row, [86, 80, 86])).toEqual([1, 0, 1]);
    expect(h.emails).toHaveLength(2);
  });

  it('forgets the crossing once the disk is 5 points under, without sending anything', async () => {
    const row = server({ isManaged: false, diskNotifiedAt: new Date('2026-11-01T00:00:00Z') });
    expect(await hourly(row, [80])).toEqual([0]);
    expect(row.diskNotifiedAt).toBeNull();
    expect(h.emails).toHaveLength(0);
  });

  it('does not write the notified time on a run that changes nothing', async () => {
    h.rows = [server({ isManaged: false, diskNotifiedAt: new Date('2026-11-01T00:00:00Z') })];
    h.disk = [92];
    await serverDiskService.checkAll(new Date(start));
    expect(h.updates[0]).not.toHaveProperty('diskNotifiedAt');
  });

  it("uses the server's own threshold when one is set", async () => {
    const low = server({ isManaged: false, diskAlertPercent: 70 });
    expect(await hourly(low, [69, 72, 66, 65, 71])).toEqual([0, 1, 0, 0, 1]);
    expect(h.emails[0]).toMatchObject({ usedPercent: 72, alertPercent: 70 });

    h.emails = [];
    const high = server({ isManaged: false, diskAlertPercent: 95 });
    expect(await hourly(high, [86, 94, 95])).toEqual([0, 0, 1]);
    expect(h.emails).toEqual([expect.objectContaining({ usedPercent: 95, alertPercent: 95 })]);
  });
});
