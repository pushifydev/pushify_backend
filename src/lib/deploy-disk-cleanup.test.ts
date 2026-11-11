import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDeployDiskCleanupScript,
  describeCleanupForError,
  parseDeployDiskCleanupOutput,
  parseDockerCreatedAt,
  parseImageInventory,
  runDeployDiskCleanup,
  selectOldProjectImages,
  IMAGE_INVENTORY_COMMAND,
  ROLLBACK_IMAGES_KEPT,
  type InventoryImage,
} from './deploy-disk-cleanup';
import type { SSHClient } from '../utils/ssh';

const day = (n: number) => `2026-11-${String(n).padStart(2, '0')} 12:00:00 +0000 UTC`;

/** One deploy of `repo`: the same image tagged `<commit>` and `deploy-<id>` (as remote-deployment does). */
function deploy(repo: string, n: number, extraTags: string[] = []): InventoryImage[] {
  const id = `sha256:${repo}-${n}`;
  return [`c${n}abcde`, `deploy-${n}0000000`, ...extraTags].map((tag) => ({
    repository: repo,
    tag,
    id,
    createdAt: day(n),
  }));
}

describe('selectOldProjectImages', () => {
  it('keeps the newest N images per project for rollback and removes the older ones', () => {
    // 8 deploys of one project, newest (day 8) is also `latest`
    const images = [1, 2, 3, 4, 5, 6, 7].flatMap((n) => deploy('pushify-shop', n)).concat(deploy('pushify-shop', 8, ['latest']));

    const refs = selectOldProjectImages(images, new Set(), 5);

    // days 4–8 survive (5 images, all their tags — the deploy-<id> tag is what quick rollback uses)
    for (const n of [4, 5, 6, 7, 8]) {
      expect(refs).not.toContain(`pushify-shop:deploy-${n}0000000`);
      expect(refs).not.toContain(`pushify-shop:c${n}abcde`);
    }
    expect(refs).not.toContain('pushify-shop:latest');
    expect(refs.sort()).toEqual(
      [1, 2, 3].flatMap((n) => [`pushify-shop:c${n}abcde`, `pushify-shop:deploy-${n}0000000`]).sort()
    );
  });

  it('never removes the image a container runs (or a stopped one uses), nor `latest`, however old', () => {
    const images = [
      ...deploy('pushify-shop', 1), // running (rolled back to an old image)
      ...deploy('pushify-shop', 2, ['latest']),
      ...[3, 4, 5, 6, 7, 8].flatMap((n) => deploy('pushify-shop', n)),
    ];

    const refs = selectOldProjectImages(images, new Set(['sha256:pushify-shop-1']), 5);

    expect(refs.some((r) => r.endsWith('c1abcde') || r.endsWith('deploy-10000000'))).toBe(false);
    expect(refs).not.toContain('pushify-shop:latest');
    expect(refs).not.toContain('pushify-shop:c2abcde');
    expect(refs).toEqual(['pushify-shop:c3abcde', 'pushify-shop:deploy-30000000']);
  });

  it('counts per project: one busy project does not push out another project’s rollback images', () => {
    const images = [
      ...[1, 2, 3, 4, 5, 6].flatMap((n) => deploy('pushify-shop', n)),
      ...[1, 2].flatMap((n) => deploy('pushify-blog', n)),
    ];
    const refs = selectOldProjectImages(images, new Set(), 5);
    expect(refs.every((r) => r.startsWith('pushify-shop:'))).toBe(true);
    expect(refs).toHaveLength(2);
  });

  it('leaves non-Pushify images, dangling ones and images of unknown age alone', () => {
    const images: InventoryImage[] = [
      ...[1, 2, 3].map((n) => ({ repository: 'postgres', tag: `1${n}`, id: `sha256:pg${n}`, createdAt: day(n) })),
      { repository: 'pushify-shop', tag: '<none>', id: 'sha256:dangling', createdAt: day(1) },
      { repository: 'pushify-shop', tag: 'weird', id: 'sha256:weird', createdAt: 'yesterday' },
      ...[2, 3].flatMap((n) => deploy('pushify-shop', n)),
    ];
    expect(selectOldProjectImages(images, new Set(), 1)).toEqual([
      'pushify-shop:c2abcde',
      'pushify-shop:deploy-20000000',
    ]);
  });

  it('defaults to the rollback window', () => {
    expect(ROLLBACK_IMAGES_KEPT).toBe(5);
    const images = [1, 2, 3, 4, 5].flatMap((n) => deploy('pushify-shop', n));
    expect(selectOldProjectImages(images, new Set())).toEqual([]);
  });
});

describe('parseImageInventory / parseDockerCreatedAt', () => {
  it('reads images and the images containers use', () => {
    const out = [
      'IMG|pushify-shop|abc1234|sha256:aaa|2026-11-10 16:36:00 +0000 UTC',
      'IMG|postgres|16|sha256:bbb|2026-10-01 10:00:00 +0200 CEST',
      'USE|sha256:aaa',
      '',
    ].join('\n');
    const { images, inUse } = parseImageInventory(out);
    expect(images).toEqual([
      { repository: 'pushify-shop', tag: 'abc1234', id: 'sha256:aaa', createdAt: '2026-11-10 16:36:00 +0000 UTC' },
      { repository: 'postgres', tag: '16', id: 'sha256:bbb', createdAt: '2026-10-01 10:00:00 +0200 CEST' },
    ]);
    expect([...inUse]).toEqual(['sha256:aaa']);
  });

  it('parses docker timestamps with their offset', () => {
    expect(parseDockerCreatedAt('2026-10-01 10:00:00 +0200 CEST')).toBe(Date.parse('2026-10-01T08:00:00Z'));
    expect(parseDockerCreatedAt('nonsense')).toBeNull();
  });

  it('lists every container’s image, stopped ones included', () => {
    expect(IMAGE_INVENTORY_COMMAND).toContain('docker ps -aq');
  });
});

describe('buildDeployDiskCleanupScript', () => {
  const script = buildDeployDiskCleanupScript(['pushify-shop:c1abcde', "pushify-x:it's"]);

  it('is valid shell', () => {
    const res = spawnSync('bash', ['-n'], { input: script });
    if (res.error) return; // no bash on this machine
    expect(res.status, String(res.stderr)).toBe(0);
    const empty = spawnSync('bash', ['-n'], { input: buildDeployDiskCleanupScript([]) });
    expect(empty.status, String(empty.stderr)).toBe(0);
  });

  it('never touches volumes and never forces a removal', () => {
    expect(script).not.toMatch(/volume|--volumes|system prune|container prune/);
    expect(script).not.toMatch(/docker\s+(rm|rmi)\s+-f|rm -v|image prune -a/);
    expect(script).not.toMatch(/docker\s+(stop|kill|restart|compose)\b/);
  });

  it('prunes all build cache and dangling images, removes only the chosen old images', () => {
    expect(script).toContain('docker builder prune -af >/dev/null 2>&1 || true');
    expect(script).toContain('docker image prune -f >/dev/null 2>&1 || true');
    expect(script).toContain("for ref in 'pushify-shop:c1abcde' 'pushify-x:it'\\''s'; do");
    expect(script).toContain('docker rmi "$ref"');
    expect(buildDeployDiskCleanupScript([])).not.toContain('docker rmi');
  });

  it('removes only dead Pushify containers — never databases or compose stacks', () => {
    expect(script).toContain('--filter status=dead');
    expect(script).toContain('/pushify-db-*) continue');
    expect(script).toContain('com.docker.compose.project');
  });

  it('runs against docker: removes the chosen images and only the plain dead app container', () => {
    // A fake `docker` (a shell function ahead of the script) that records every call and
    // answers the lookups: c1 a plain app container, c2 a database, c3 a compose service
    const dir = mkdtempSync(join(tmpdir(), 'pushify-cleanup-'));
    const log = join(dir, 'calls.log');
    writeFileSync(log, '');
    const fakeDocker = [
      'docker() {',
      `  echo "$*" >> '${log}'`,
      '  case "$1 $2" in',
      '    "ps -aq") echo c1; echo c2; echo c3; echo c4 ;;',
      '    "inspect --format") case "$4" in',
      "      c1) echo '/pushify-shop-blue|' ;;",
      "      c2) echo '/pushify-db-main|' ;;",
      "      c3) echo '/pushify-stack-web-1|pushify-stack' ;;",
      "      c4) echo '/someone-else|<no value>' ;;",
      '    esac ;;',
      "    \"system df\") echo 'DF|Local Volumes|5GB'; echo 'DF|Images|1GB' ;;",
      '  esac',
      '  return 0',
      '}',
    ].join('\n');

    const res = spawnSync('sh', [], {
      input: `${fakeDocker}\n${buildDeployDiskCleanupScript(['pushify-shop:c1abcde', 'pushify-shop:deploy-10000000'])}`,
      encoding: 'utf8',
    });
    if (res.error) return; // no sh on this machine
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    rmSync(dir, { recursive: true, force: true });

    expect(calls.filter((c) => c.startsWith('rm '))).toEqual(['rm c1']);
    expect(calls.filter((c) => c.startsWith('rmi '))).toEqual(['rmi pushify-shop:c1abcde', 'rmi pushify-shop:deploy-10000000']);
    expect(calls).toContain('image prune -f');
    expect(calls).toContain('builder prune -af');
    const r = parseDeployDiskCleanupOutput(res.stdout);
    expect(r).toMatchObject({ ran: true, removedContainers: 1, removedImages: 2 });
    expect(r.usage.map((u) => u.type)).toEqual(['Local Volumes', 'Images']);
  });
});

describe('parseDeployDiskCleanupOutput', () => {
  it('reads what was freed and the largest items, biggest first', () => {
    const r = parseDeployDiskCleanupOutput(
      [
        'DF|Images|6.1GB',
        'DF|Containers|120MB',
        'DF|Local Volumes|20.4GB',
        'DF|Build Cache|0B',
        'PUSHIFY_DEPLOY_CLEANUP before=40000000000 after=36778774528 containers=1 images=6',
      ].join('\n')
    );
    expect(r).toMatchObject({ ran: true, freedBytes: 3221225472, removedContainers: 1, removedImages: 6 });
    expect(r.usage.map((u) => u.type)).toEqual(['Local Volumes', 'Images', 'Containers', 'Build Cache']);
    expect(describeCleanupForError(r)).toBe(
      'Automatic cleanup freed 3 GB; largest on disk: Local Volumes 20.4GB, Images 6.1GB, Containers 120MB.'
    );
  });

  it('is not-ran without the summary line', () => {
    const r = parseDeployDiskCleanupOutput('');
    expect(r.ran).toBe(false);
    expect(describeCleanupForError(r)).toBe('The automatic cleanup could not run.');
  });
});

describe('runDeployDiskCleanup', () => {
  it('removes the old images it found in the inventory', async () => {
    const commands: string[] = [];
    const ssh = {
      exec: async (cmd: string) => {
        commands.push(cmd);
        if (cmd === IMAGE_INVENTORY_COMMAND) {
          const lines = [1, 2, 3].flatMap((n) =>
            deploy('pushify-shop', n).map((i) => `IMG|${i.repository}|${i.tag}|${i.id}|${i.createdAt}`)
          );
          return { code: 0, stdout: lines.join('\n'), stderr: '' };
        }
        return { code: 0, stdout: 'PUSHIFY_DEPLOY_CLEANUP before=10 after=4 containers=0 images=2', stderr: '' };
      },
    } as unknown as SSHClient;

    const r = await runDeployDiskCleanup(ssh, 2);

    expect(r).toMatchObject({ ran: true, freedBytes: 6, removedImages: 2 });
    expect(commands[1]).toContain("for ref in 'pushify-shop:c1abcde' 'pushify-shop:deploy-10000000'; do");
  });

  it('never throws', async () => {
    const ssh = { exec: async () => { throw new Error('ssh down'); } } as unknown as SSHClient;
    expect((await runDeployDiskCleanup(ssh)).ran).toBe(false);
  });
});
