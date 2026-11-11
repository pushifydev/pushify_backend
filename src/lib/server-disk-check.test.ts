import { describe, it, expect } from 'vitest';
import {
  checkServerDiskSpace,
  deployDiskBlockReason,
  diskAlertPercentFor,
  isValidDiskAlertPercent,
  nextDiskAlertState,
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

describe('nextDiskAlertState', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  const earlier = new Date('2026-11-10T12:00:00Z');
  const read = (usedPercent: number, measured = true) => ({ usedPercent, measured });

  it('notifies on the first reading at or over the threshold', () => {
    expect(nextDiskAlertState(null, read(84), 85, now)).toEqual({ notify: false, notifiedAt: null });
    expect(nextDiskAlertState(null, read(85), 85, now)).toEqual({ notify: true, notifiedAt: now });
  });

  it('stays quiet while it is still over, with no reminder however long ago the alert went out', () => {
    expect(nextDiskAlertState(earlier, read(97), 85, now)).toEqual({ notify: false, notifiedAt: earlier });
  });

  it('only re-arms once the disk is 5 points under the threshold', () => {
    expect(nextDiskAlertState(earlier, read(81), 85, now)).toEqual({ notify: false, notifiedAt: earlier });
    expect(nextDiskAlertState(earlier, read(80), 85, now)).toEqual({ notify: false, notifiedAt: null });
  });

  it('leaves the state alone on a reading it could not measure', () => {
    expect(nextDiskAlertState(earlier, read(0, false), 85, now)).toEqual({ notify: false, notifiedAt: earlier });
    expect(nextDiskAlertState(null, read(99, false), 85, now)).toEqual({ notify: false, notifiedAt: null });
  });
});

describe('disk alert threshold setting', () => {
  it('defaults to 85, before deploys stop at 90', () => {
    expect(diskAlertPercentFor({ diskAlertPercent: null })).toBe(85);
    expect(diskAlertPercentFor({ diskAlertPercent: 70 })).toBe(70);
  });

  it('accepts whole numbers from 50 up to just under the deploy block', () => {
    expect(isValidDiskAlertPercent(50)).toBe(true);
    expect(isValidDiskAlertPercent(89)).toBe(true);
    expect(isValidDiskAlertPercent(90)).toBe(false);
    expect(isValidDiskAlertPercent(49)).toBe(false);
    expect(isValidDiskAlertPercent(85.5)).toBe(false);
    expect(isValidDiskAlertPercent('85')).toBe(false);
  });
});
