import { describe, it, expect } from 'vitest';
import { checkServerDiskSpace, deployDiskBlockReason } from './server-disk-check';
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
