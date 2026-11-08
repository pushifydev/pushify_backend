import { describe, it, expect, vi } from 'vitest';
import type { SSHClient } from '../utils/ssh';
import {
  containersUsingVolumesCommand,
  copyVolumesToTarget,
  parseFreeBytes,
  parseVolumeDigest,
  parseVolumeSizes,
  prepareTargetVolumeCommand,
  restartOnSource,
  tarCreateCommand,
  volumeDigestCommand,
} from './project-volume-transfer';

const GiB = 1024 ** 3;
const SUM = 'a'.repeat(64);
const VOL = 'pushify-vol-yeli-uploads';

type Reply = { stdout?: string; stderr?: string; code?: number };

/** A fake server: answers each command by the first rule whose pattern it contains */
function fakeServer(rules: [string, Reply | (() => Reply)][]) {
  const calls: string[] = [];
  const ssh = {
    calls,
    exec: vi.fn(async (cmd: string) => {
      calls.push(cmd);
      const rule = rules.find(([pattern]) => cmd.includes(pattern));
      const reply = rule ? (typeof rule[1] === 'function' ? rule[1]() : rule[1]) : {};
      return { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', code: reply.code ?? 0 };
    }),
    execPipeTo: vi.fn(async () => ({ code: 0, stderr: '', targetCode: 0, targetStderr: '' })),
  };
  return ssh as typeof ssh & SSHClient;
}

/** A source with one running app container using the volume, stopped once `docker stop` ran */
function source(digest = `12 4096 ${SUM}`, size = `${VOL} 4096`) {
  let stopped = false;
  return fakeServer([
    ['du -sb', { stdout: size }],
    ['docker stop', () => ((stopped = true), {})],
    ['docker ps --filter volume', () => ({ stdout: stopped ? '' : 'pushify-yeli-blue\n' })],
    ['sha256sum', { stdout: digest }],
  ]);
}

function target(free = 50 * GiB, digest = `12 4096 ${SUM}`) {
  return fakeServer([
    ['df -PB1', { stdout: `${free}\n` }],
    ['docker volume create', {}],
    ['sha256sum', { stdout: digest }],
  ]);
}

const options = (over: Partial<Parameters<typeof copyVolumesToTarget>[2]> = {}) => ({
  names: [VOL],
  requiredFreeBytes: (total: number) => total + GiB,
  onLog: vi.fn(),
  onStopping: vi.fn(),
  ...over,
});

describe('parsers', () => {
  it('reads volume sizes, a volume missing on the server, and output it cannot use', () => {
    const sizes = parseVolumeSizes(`${VOL} 4096\npushify-vol-yeli-new -\npushify-vol-yeli-odd \n`, [
      VOL,
      'pushify-vol-yeli-new',
      'pushify-vol-yeli-odd',
      'pushify-vol-yeli-absent',
    ]);
    expect(sizes.get(VOL)).toEqual({ exists: true, bytes: 4096 });
    expect(sizes.get('pushify-vol-yeli-new')).toEqual({ exists: false, bytes: 0 });
    expect(sizes.get('pushify-vol-yeli-odd')).toBeNull();
    expect(sizes.get('pushify-vol-yeli-absent')).toBeNull();
  });

  it('reads free bytes and a digest', () => {
    expect(parseFreeBytes('53687091200\n')).toBe(53687091200);
    expect(parseFreeBytes('')).toBeNull();
    expect(parseVolumeDigest(`12 4096 ${SUM}\n`)).toEqual({ files: 12, bytes: 4096, sha256: SUM });
    expect(parseVolumeDigest('12 4096 nope')).toBeNull();
  });
});

describe('commands', () => {
  it('refuses a volume name that is not a Pushify volume', () => {
    expect(() => tarCreateCommand('x; rm -rf /')).toThrow(/Unsafe volume name/);
    expect(() => containersUsingVolumesCommand(['$(id)'])).toThrow(/Unsafe volume name/);
  });

  it('streams the volume directory only when Docker knows it, and empties only a local volume on the target', () => {
    expect(tarCreateCommand(VOL)).toMatch(/^m=\$\(docker volume inspect -f '\{\{\.Mountpoint\}\}' pushify-vol-yeli-uploads\) && \[ -d "\$m" \] && tar/);
    expect(prepareTargetVolumeCommand(VOL)).toContain(`*/volumes/${VOL}/_data) find "$m" -mindepth 1 -delete`);
  });

  it('checksums content, paths, modes and owners, sorted the same way on both servers', () => {
    const cmd = volumeDigestCommand(VOL);
    expect(cmd).toContain('xargs -0 -r sha256sum');
    expect(cmd).toContain("%y %m %U:%G %p");
    expect(cmd).toContain('LC_ALL=C sort');
  });
});

describe('copyVolumesToTarget', () => {
  it('stops what uses the volume on the source, streams it and checks the copy', async () => {
    const src = source();
    const dst = target();
    const opts = options();

    await copyVolumesToTarget(src, dst, opts);

    expect(opts.onStopping).toHaveBeenCalledWith(['pushify-yeli-blue']);
    const stopAt = src.calls.findIndex((c) => c.startsWith('docker stop pushify-yeli-blue'));
    expect(stopAt).toBeGreaterThan(-1);
    expect(src.execPipeTo).toHaveBeenCalledWith(tarCreateCommand(VOL), dst, expect.stringContaining('tar --numeric-owner -C "$m" -xpf -'));
    expect(dst.calls.some((c) => c.startsWith(`docker volume create ${VOL}`))).toBe(true);
    // The source is only read: nothing there is created, emptied or removed
    expect(src.calls.some((c) => /volume (create|rm)|-delete|tar .*-x/.test(c))).toBe(false);
    expect(opts.onLog).toHaveBeenCalledWith(expect.stringMatching(/copied and verified: 12 files/));
  });

  it('does not stop anything when the target lacks disk space', async () => {
    const src = source(undefined, `${VOL} ${5 * GiB}`);
    const dst = target(5 * GiB);
    const opts = options();

    await expect(copyVolumesToTarget(src, dst, opts)).rejects.toThrow(/Not enough free disk on the target/);
    expect(opts.onStopping).not.toHaveBeenCalled();
    expect(src.calls.some((c) => c.startsWith('docker stop'))).toBe(false);
    expect(src.execPipeTo).not.toHaveBeenCalled();
  });

  it('does not stop anything when a volume cannot be measured', async () => {
    const src = source(undefined, '');
    const opts = options();
    await expect(copyVolumesToTarget(src, target(), opts)).rejects.toThrow(/Could not measure/);
    expect(opts.onStopping).not.toHaveBeenCalled();
  });

  it('fails when the copy does not match the source', async () => {
    const opts = options();
    await expect(copyVolumesToTarget(source(), target(50 * GiB, `11 4000 ${'b'.repeat(64)}`), opts)).rejects.toThrow(
      /does not match the current server \(12 files, 4096 bytes there; 11 files, 4000 bytes on the target\)/
    );
    // The caller restarts these
    expect(opts.onStopping).toHaveBeenCalledWith(['pushify-yeli-blue']);
  });

  it('fails when the stream breaks', async () => {
    const src = source();
    src.execPipeTo.mockResolvedValue({ code: 0, stderr: '', targetCode: 2, targetStderr: 'tar: write error: No space left on device' });
    await expect(copyVolumesToTarget(src, target(), options())).rejects.toThrow(/No space left on device/);
  });

  it('fails when something still uses the volume after the stop', async () => {
    const src = fakeServer([
      ['du -sb', { stdout: `${VOL} 4096` }],
      ['docker ps --filter volume', { stdout: 'pushify-yeli-blue\n' }],
    ]);
    await expect(copyVolumesToTarget(src, target(), options())).rejects.toThrow(/still use the volumes/);
    expect(src.execPipeTo).not.toHaveBeenCalled();
  });

  it('starts a volume the source never created empty on the target, without streaming', async () => {
    const src = source(undefined, `${VOL} -`);
    const dst = target();
    await copyVolumesToTarget(src, dst, options());
    expect(src.execPipeTo).not.toHaveBeenCalled();
    expect(dst.calls.some((c) => c.startsWith(`docker volume create ${VOL}`))).toBe(true);
  });
});

describe('restartOnSource', () => {
  it('starts exactly the stopped containers', async () => {
    const src = fakeServer([['docker start', {}]]);
    expect(await restartOnSource(src, ['pushify-yeli-blue', 'pushify-yeli-worker-queue'])).toBe(true);
    expect(src.calls).toEqual(['docker start pushify-yeli-blue pushify-yeli-worker-queue']);
    expect(await restartOnSource(src, [])).toBe(true);
    await expect(restartOnSource(src, ['bad;name'])).rejects.toThrow(/Unsafe container name/);
  });
});
