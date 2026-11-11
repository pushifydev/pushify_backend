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
    // -1 stands for a `df` that printed nothing usable
    const measured = usedPercent >= 0;
    return {
      usedPercent: measured ? usedPercent : 0, availGb: 5, mount: '/', measured,
      warn: usedPercent >= 85, critical: usedPercent >= 95, ok: true, message: '',
    };
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
  isManaged: true, diskNotifiedAt: null, ...over,
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

describe('serverDiskService.checkAll alert (one per crossing, no reminders)', () => {
  const HOUR = 60 * 60 * 1000;
  const start = new Date('2026-11-11T00:00:00Z').getTime();

  /** One hourly run per reading, carrying what the previous run stored into the next one. */
  async function hourly(readings: number[], over: Record<string, unknown> = {}) {
    // Bring-your-own: no cleanup, so each run reads the disk exactly once
    let row: Record<string, unknown> = server({ isManaged: false, ...over });
    const sent: number[] = [];
    for (const [i, reading] of readings.entries()) {
      h.rows = [row];
      h.disk = [reading];
      h.updates = [];
      const before = h.emails.length;
      await serverDiskService.checkAll(new Date(start + i * HOUR));
      sent.push(h.emails.length - before);
      row = { ...row, ...h.updates[0] };
    }
    return { sent, row };
  }

  it('sends one alert on the first crossing, with free GB and where deploys stop', async () => {
    const { sent, row } = await hourly([80, 86]);
    expect(sent).toEqual([0, 1]);
    expect(h.emails[0]).toMatchObject({ usedPercent: 86, availGb: 5, serverId: 's1', deployBlockPercent: 90, deployMinFreeGb: 2 });
    expect(row.diskNotifiedAt).toEqual(new Date(start + HOUR));
  });

  it('sends nothing more while the disk stays high, however long and however much higher', async () => {
    // 30 hours over the line, climbing past critical: still the one alert, no daily reminder
    const readings = [86, ...Array.from({ length: 29 }, (_, i) => 86 + (i % 10))];
    const { sent } = await hourly(readings);
    expect(sent.reduce((a, b) => a + b, 0)).toBe(1);
    expect(sent[0]).toBe(1);
  });

  it('does not re-arm until the disk is 5 points under the threshold', async () => {
    // 82 is under 85 but inside the margin: crossing back to 86 is the same episode
    const { sent } = await hourly([86, 82, 86, 81, 87]);
    expect(sent).toEqual([1, 0, 0, 0, 0]);
  });

  it('sends a new alert after it dropped 5 points under the threshold and crossed it again', async () => {
    const { sent, row } = await hourly([86, 80, 85]);
    expect(sent).toEqual([1, 0, 1]);
    expect(row.diskNotifiedAt).toEqual(new Date(start + 2 * HOUR));
  });

  it('uses the threshold set on the server instead of the default', async () => {
    const { sent } = await hourly([70, 75, 80, 69, 75], { diskAlertPercent: 75 });
    expect(sent).toEqual([0, 1, 0, 0, 1]);
  });

  it('does not re-arm on a reading it could not measure', async () => {
    const { sent } = await hourly([86, -1, 86]);
    expect(sent).toEqual([1, 0, 0]);
  });
});
