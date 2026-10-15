import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  buildDiskCleanupScript,
  parseDiskCleanupOutput,
  runServerDiskCleanup,
  DOCKER_DAEMON_JSON,
} from './server-disk-cleanup';
import type { SSHClient } from '../utils/ssh';

describe('buildDiskCleanupScript', () => {
  const script = buildDiskCleanupScript();

  it('is valid shell', () => {
    const res = spawnSync('bash', ['-n'], { input: script });
    if (res.error) return; // no bash on this machine
    expect(res.status, String(res.stderr)).toBe(0);
  });

  it('never touches volumes, containers or the running daemon', () => {
    expect(script).not.toMatch(/volume prune|system prune|container prune|docker rm\b/);
    expect(script).not.toMatch(/systemctl|service docker|kill/);
    expect(script).not.toMatch(/image prune -a/);
  });

  it('caps logs, trims dangling images and old build cache', () => {
    expect(script).toContain("-name '*-json.log' -size +100M");
    expect(script).toContain('truncate -s 0');
    expect(script).toContain('docker image prune -f');
    expect(script).toContain('docker builder prune -af --filter until=72h');
  });

  it('writes the daemon log default only when no daemon.json exists', () => {
    expect(script).toContain('if [ ! -e /etc/docker/daemon.json ]; then');
    expect(script).toContain(DOCKER_DAEMON_JSON);
    expect(JSON.parse(DOCKER_DAEMON_JSON)).toEqual({
      'log-driver': 'json-file',
      'log-opts': { 'max-size': '10m', 'max-file': '3' },
    });
  });
});

describe('parseDiskCleanupOutput', () => {
  it('reads freed space, truncated logs and volume size', () => {
    const out = 'noise\nPUSHIFY_CLEANUP before=34000000000 after=27000000000 logs=6500000000 daemon=created volumes=12.5GB\n';
    expect(parseDiskCleanupOutput(out)).toEqual({
      ran: true,
      freedBytes: 7_000_000_000,
      logsTruncatedBytes: 6_500_000_000,
      daemonConfig: 'created',
      volumesBytes: 12_500_000_000,
    });
  });

  it('never reports negative freed space (disk grew meanwhile)', () => {
    const r = parseDiskCleanupOutput('PUSHIFY_CLEANUP before=10 after=20 logs=0 daemon=present volumes=0B');
    expect(r.freedBytes).toBe(0);
    expect(r.daemonConfig).toBe('present');
  });

  it('reports not-ran when the summary line is missing', () => {
    expect(parseDiskCleanupOutput('bash: docker: command not found').ran).toBe(false);
  });

  it('runServerDiskCleanup never throws', async () => {
    const ssh = { exec: async () => { throw new Error('boom'); } } as unknown as SSHClient;
    await expect(runServerDiskCleanup(ssh)).resolves.toMatchObject({ ran: false });
  });
});
