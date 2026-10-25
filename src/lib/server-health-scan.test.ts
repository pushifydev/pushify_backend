import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  patchStdout: '' as string,
  patchThrows: false,
  disconnects: 0,
}));

vi.mock('../db', () => ({
  db: { select: () => ({ from: () => ({ where: async () => [{ slug: 'web' }] }) }) },
}));
vi.mock('./encryption', () => ({ decrypt: (s: string) => s }));
vi.mock('./server-disk-check', () => ({
  checkServerDiskSpace: async () => ({
    ok: true, usedPercent: 40, availGb: 20, mount: '/', warn: false, critical: false, message: '', measured: true,
  }),
}));
vi.mock('../utils/ssh', () => ({
  getSSHConnection: async () => ({
    exec: async (cmd: string) => {
      if (cmd.includes('PUSHIFY_PATCH')) {
        if (h.patchThrows) throw new Error('SSH stream error: channel closed');
        return { code: 0, stdout: h.patchStdout, stderr: '' };
      }
      return { code: 0, stdout: 'pushify-web|Up 2 hours|80/tcp\npushify-old|Exited (0)|\n', stderr: '' };
    },
    disconnect: () => { h.disconnects++; },
  }),
}));

import { scanServerHealth } from './server-health-scan';

const byos = { ipv4: '203.0.113.7', sshPrivateKey: 'k', provider: 'self_hosted', isManaged: false };
const managed = { ipv4: '198.51.100.4', sshPrivateKey: 'k', provider: 'hetzner', isManaged: true };

beforeEach(() => {
  h.patchStdout = '';
  h.patchThrows = false;
  h.disconnects = 0;
});

describe('scanServerHealth patch status', () => {
  it('adds the patch status to the report, with the same fields for BYOS and managed servers', async () => {
    h.patchStdout = 'PUSHIFY_PATCH apt=yes\nPUSHIFY_PATCH aptcheck=7;2\nPUSHIFY_PATCH reboot=yes\n';
    const a = await scanServerHealth(byos, 'o1');
    const b = await scanServerHealth(managed, 'o1');
    expect(a.patch).toMatchObject({ pending: 7, security: 2, rebootRequired: true });
    expect(Object.keys(a.patch).sort()).toEqual(['checkedAt', 'pending', 'rebootRequired', 'security', 'unattendedUpgrades']);
    expect(Object.keys(b.patch).sort()).toEqual(Object.keys(a.patch).sort());
    expect(Object.keys(b.patch.unattendedUpgrades).sort()).toEqual(['enabled', 'lastRunAt']);
  });

  it('keeps the rest of the report when the patch command fails', async () => {
    h.patchThrows = true;
    const r = await scanServerHealth(managed, 'o1');
    expect(r.disk.usedPercent).toBe(40);
    expect(r.pushifyContainerCount).toBe(2);
    expect(r.orphans.map((o) => o.name)).toEqual(['pushify-old']);
    expect(r.patch).toMatchObject({
      pending: 'unknown',
      security: 'unknown',
      rebootRequired: 'unknown',
      unattendedUpgrades: { enabled: 'unknown', lastRunAt: null },
    });
    expect(typeof r.patch.checkedAt).toBe('string');
    expect(h.disconnects).toBe(1);
  });

  it('reports unknown on a distro without apt', async () => {
    h.patchStdout = 'PUSHIFY_PATCH apt=no\n';
    const r = await scanServerHealth(byos, 'o1');
    expect(r.patch.pending).toBe('unknown');
    expect(r.patch.rebootRequired).toBe('unknown');
  });
});
