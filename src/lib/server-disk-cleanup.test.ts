import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  buildDiskBreakdown,
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

  it('keeps images of running apps and the tagged rollback images (deploy-*, latest)', () => {
    // The only image removal is a dangling-only prune: Docker never prunes an image a container
    // (running or sleeping) uses, and rollback images are tagged `deploy-<id>` / `latest`.
    const imageRemovals = script.split('\n').filter((l) => /docker (image|rmi)\b/.test(l));
    expect(imageRemovals).toEqual(['docker image prune -f >/dev/null 2>&1 || true']);
    expect(script).not.toMatch(/docker rmi|docker image rm\b|image prune[^\n]*\s-(a|-all|-filter)/);
  });

  it('caps logs, trims dangling images and old build cache', () => {
    expect(script).toContain("-name '*-json.log' -size +100M");
    expect(script).toContain('truncate -s 0');
    expect(script).toContain('docker image prune -f');
    expect(script).toContain('docker builder prune -af --filter until=72h');
  });

  it('finds existing containers without a log cap and rotates their log above the cap size', () => {
    expect(script).toContain('docker ps -aq --no-trunc');
    expect(script).toContain('{{.HostConfig.LogConfig.Type}} {{index .HostConfig.LogConfig.Config "max-size"}}');
    expect(script).toContain('$((30 * 1024 * 1024))');
    expect(script).toMatch(/uncapped=\$\{UNCAPPED:-0\} rotated=\$\{ROTATED:-0\}/);
  });

  it('reports images, build cache, containers, logs and volumes', () => {
    for (const t of ['"Local Volumes"', 'Images', '"Build Cache"', 'Containers']) expect(script).toContain(`dfsize ${t}`);
    expect(script).toMatch(/images=.*buildcache=.*containers=.*logfiles=/);
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
    expect(parseDiskCleanupOutput(out)).toMatchObject({
      ran: true,
      freedBytes: 7_000_000_000,
      logsTruncatedBytes: 6_500_000_000,
      daemonConfig: 'created',
      volumesBytes: 12_500_000_000,
      imagesBytes: 0,
      uncappedLogContainers: 0,
    });
  });

  it('reads the disk breakdown and the uncapped-log containers', () => {
    const out =
      'PUSHIFY_CLEANUP before=34000000000 after=33000000000 logs=900000000 daemon=present volumes=25GB ' +
      'images=4.2GB buildcache=512MB containers=120MB logfiles=60000000 uncapped=9 rotated=3 total=38000000000';
    expect(parseDiskCleanupOutput(out)).toMatchObject({
      volumesBytes: 25e9,
      imagesBytes: 4.2e9,
      buildCacheBytes: 512e6,
      containersBytes: 120e6,
      logsBytes: 60e6,
      uncappedLogContainers: 9,
      rotatedLogContainers: 3,
      usedBytes: 33e9,
      totalBytes: 38e9,
    });
  });

  it('never reports negative freed space (disk grew meanwhile)', () => {
    const r = parseDiskCleanupOutput('PUSHIFY_CLEANUP before=10 after=20 logs=0 daemon=present volumes=0B');
    expect(r.freedBytes).toBe(0);
    expect(r.daemonConfig).toBe('present');
  });

  it('breakdown labels a volume-dominated disk as user data', () => {
    const r = parseDiskCleanupOutput(
      'PUSHIFY_CLEANUP before=34000000000 after=33000000000 logs=0 daemon=present volumes=25GB ' +
        'images=4GB buildcache=0B containers=0B logfiles=60000000 uncapped=2 rotated=0 total=38000000000'
    );
    const b = buildDiskBreakdown(r, new Date('2026-10-16T00:00:00Z'));
    expect(b).toMatchObject({ heldBy: 'volumes', userData: true, uncappedLogContainers: 2, measuredAt: '2026-10-16T00:00:00.000Z' });
  });

  it('breakdown names images or logs when those dominate, and "other" when docker is not the cause', () => {
    const images = parseDiskCleanupOutput(
      'PUSHIFY_CLEANUP before=1 after=30000000000 logs=0 daemon=present volumes=1GB images=20GB buildcache=0B containers=0B logfiles=0'
    );
    expect(buildDiskBreakdown(images)).toMatchObject({ heldBy: 'images', userData: false });
    const logs = parseDiskCleanupOutput(
      'PUSHIFY_CLEANUP before=1 after=30000000000 logs=0 daemon=present volumes=1GB images=2GB buildcache=0B containers=0B logfiles=25000000000'
    );
    expect(buildDiskBreakdown(logs).heldBy).toBe('logs');
    const other = parseDiskCleanupOutput(
      'PUSHIFY_CLEANUP before=1 after=30000000000 logs=0 daemon=present volumes=1GB images=2GB buildcache=0B containers=0B logfiles=0'
    );
    expect(buildDiskBreakdown(other)).toMatchObject({ heldBy: 'other', userData: false });
  });

  it('reports not-ran when the summary line is missing', () => {
    expect(parseDiskCleanupOutput('bash: docker: command not found').ran).toBe(false);
  });

  it('runServerDiskCleanup never throws', async () => {
    const ssh = { exec: async () => { throw new Error('boom'); } } as unknown as SSHClient;
    await expect(runServerDiskCleanup(ssh)).resolves.toMatchObject({ ran: false });
  });
});
