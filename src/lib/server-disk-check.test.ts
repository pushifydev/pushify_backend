import { describe, it, expect } from 'vitest';
import {
  checkServerDiskSpace,
  deployDiskBlockReason,
  diskAlertPercentOf,
  nextDiskAlert,
  DEFAULT_DEPLOY_THRESHOLDS,
} from './server-disk-check';
import { classifyDeployFailure } from './deploy-failure-classify';
import type { SSHClient } from '../utils/ssh';

const T = { blockPercent: 90, minFreeGb: 2 };
const disk = (usedPercent: number, availGb: number, measured = true) => ({ usedPercent, availGb, mount: '/', measured });

function sshReturning(stdout: string): SSHClient {
  return { exec: async () => ({ code: 0, stdout, stderr: '' }) } as unknown as SSHClient;
}

describe('deployDiskBlockReason', () => {
  it('lets a deploy through when there is room', () => {
    expect(deployDiskBlockReason(disk(85, 12), T)).toBeNull();
    expect(deployDiskBlockReason(disk(89, 2), T)).toBeNull();
  });

  it('blocks at or above the usage threshold', () => {
    const reason = deployDiskBlockReason(disk(90, 8), T);
    expect(reason).toMatch(/^Disk full: 90% used, 8 GB free on \//);
  });

  it('blocks when less than the minimum is free, whatever the percentage', () => {
    // e.g. a 20 GB disk at 85%: 3 GB is fine, 1.5 GB is not
    expect(deployDiskBlockReason(disk(85, 3), T)).toBeNull();
    expect(deployDiskBlockReason(disk(85, 1.5), T)).toContain('Disk full');
  });

  it('never blocks on a reading it could not parse', () => {
    expect(deployDiskBlockReason(disk(0, 0, false), T)).toBeNull();
  });

  it('points at the health page and resizing, never at docker system prune', () => {
    const reason = deployDiskBlockReason(disk(94, 2.3), T, 'Automatic cleanup freed 1.2 GB.')!;
    expect(reason).toContain('free). Automatic cleanup freed 1.2 GB. See the server');
    expect(reason).toMatch(/health page.*resize the server, then deploy again\.$/);
    expect(reason).not.toMatch(/prune/);
    expect(classifyDeployFailure('', reason).userHint).not.toMatch(/prune/);
  });

  it('is classified as a disk-space failure in the deploy log', () => {
    const reason = deployDiskBlockReason(disk(95, 0.5), T)!;
    expect(classifyDeployFailure('', reason).category).toBe('disk_space');
  });
});

describe('nextDiskAlert', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  const earlier = new Date('2026-11-10T12:00:00Z');
  const reading = (usedPercent: number, measured = true) => ({ usedPercent, measured });

  it('announces the first reading at or over the threshold', () => {
    expect(nextDiskAlert(null, reading(84), 85, now)).toEqual({ notifiedAt: null, notify: false });
    expect(nextDiskAlert(null, reading(85), 85, now)).toEqual({ notifiedAt: now, notify: true });
  });

  it('never announces the same crossing twice, however long it lasts', () => {
    expect(nextDiskAlert(earlier, reading(99), 85, now)).toEqual({ notifiedAt: earlier, notify: false });
  });

  it('re-arms only at 5 points or more under the threshold', () => {
    expect(nextDiskAlert(earlier, reading(81), 85, now)).toEqual({ notifiedAt: earlier, notify: false });
    expect(nextDiskAlert(earlier, reading(80), 85, now)).toEqual({ notifiedAt: null, notify: false });
  });

  it('changes nothing on a reading it could not parse', () => {
    expect(nextDiskAlert(earlier, reading(0, false), 85, now)).toEqual({ notifiedAt: earlier, notify: false });
    expect(nextDiskAlert(null, reading(0, false), 85, now)).toEqual({ notifiedAt: null, notify: false });
  });
});

describe('diskAlertPercentOf', () => {
  it("uses the server's own threshold, or 85 — before the deploy guard's 90", () => {
    expect(diskAlertPercentOf({ diskAlertPercent: 70 })).toBe(70);
    expect(diskAlertPercentOf({ diskAlertPercent: null })).toBe(85);
    expect(diskAlertPercentOf({ diskAlertPercent: null })).toBeLessThan(DEFAULT_DEPLOY_THRESHOLDS.blockPercent);
  });
});

describe('checkServerDiskSpace', () => {
  it('parses df output', async () => {
    const r = await checkServerDiskSpace(sshReturning('92 1048576 /\n'));
    expect(r).toMatchObject({ usedPercent: 92, availGb: 1, mount: '/', measured: true });
  });

  it('marks empty output as not measured', async () => {
    const r = await checkServerDiskSpace(sshReturning(''));
    expect(r.measured).toBe(false);
  });
});
