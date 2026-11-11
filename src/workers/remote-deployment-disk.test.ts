import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A deploy onto a host that is (nearly) out of disk is refused before anything is cloned,
 * pulled or started, with the reason in the deploy log and on the server's status message.
 */

const state: {
  df: string;
  /** Successive df readings (before / after the cleanup); `df` once it is empty */
  dfQueue: string[];
  inventory: string;
  cleanupOut: string;
  lockFree: boolean;
  commands: string[];
  updates: Array<Record<string, unknown>>;
  statusMessage: string | null;
} = {
  df: '',
  dfQueue: [],
  inventory: '',
  cleanupOut: '',
  lockFree: true,
  commands: [],
  updates: [],
  statusMessage: null,
};

vi.mock('../lib/server-disk-cleanup-lock', () => ({
  acquireServerDiskCleanupLock: async () => state.lockFree,
  releaseServerDiskCleanupLock: async () => {},
  waitForServerDiskCleanup: async () => true,
}));

vi.mock('../utils/ssh', () => {
  class FakeSSHClient {
    async connect() {}
    disconnect() {}
    async exec(command: string) {
      state.commands.push(command);
      if (command === 'docker --version') return { code: 0, stdout: 'Docker version 24.0.5', stderr: '' };
      if (command.startsWith('df -P /')) return { code: 0, stdout: state.dfQueue.shift() ?? state.df, stderr: '' };
      if (command.startsWith('docker images --no-trunc')) return { code: 0, stdout: state.inventory, stderr: '' };
      if (command.startsWith('used()')) return { code: 0, stdout: state.cleanupOut, stderr: '' };
      // Stop the happy path right after the disk check: the clone is the first thing it does
      if (command.startsWith('git clone')) return { code: 128, stdout: '', stderr: 'stop here' };
      return { code: 0, stdout: '', stderr: '' };
    }
    async uploadFile() {}
    async fileExists() {
      return false;
    }
    isConnected() {
      return true;
    }
  }
  return { SSHClient: FakeSSHClient };
});

vi.mock('../db', () => ({
  db: {
    query: {
      servers: {
        findFirst: vi.fn(async () => ({
          id: 'srv-1',
          status: 'running',
          setupStatus: 'completed',
          ipv4: '203.0.113.10',
          sshPrivateKey: 'encrypted-key',
          statusMessage: state.statusMessage,
        })),
      },
    },
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.updates.push(values);
        },
      }),
    })),
  },
}));

vi.mock('../lib/encryption', () => ({ decrypt: () => 'private-key' }));

const { deployToRemoteServer } = await import('./remote-deployment');

async function deploy() {
  const log: string[] = [];
  const result = await deployToRemoteServer({
    serverId: 'srv-1',
    projectId: 'proj-1',
    projectSlug: 'shop',
    deploymentId: 'dep-12345678',
    repoUrl: 'https://github.com/acme/shop.git',
    branch: 'main',
    commitHash: 'abc1234def',
    envVars: {},
    framework: 'nodejs',
    onProgress: (m: string) => log.push(m),
  } as unknown as Parameters<typeof deployToRemoteServer>[0]);
  return { result, log };
}

beforeEach(() => {
  state.commands = [];
  state.updates = [];
  state.statusMessage = null;
  state.dfQueue = [];
  state.inventory = '';
  state.cleanupOut = '';
  state.lockFree = true;
});

const cleanupScript = () => state.commands.find((c) => c.startsWith('used()'));

describe('deployToRemoteServer: disk pre-check', () => {
  it('refuses a deploy on a full disk, logs why and fills the server status message', async () => {
    state.df = '92 1572864 /'; // 92% used, 1.5 GB free

    const { result, log } = await deploy();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Disk full: 92% used, 1\.5 GB free/);
    expect(log.some((l) => l.includes('Disk full: 92% used'))).toBe(true);
    expect(state.commands.some((c) => c.startsWith('git clone') || c.startsWith('mkdir'))).toBe(false);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].statusMessage).toBe(result.error);
    expect(state.updates[0].diskUsedPercent).toBe(92);
  });

  it('refuses when less than 2 GB is free even below 90%', async () => {
    state.df = '85 1048576 /'; // 85% used, 1 GB free — the reported incident

    const { result } = await deploy();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Disk full: 85% used, 1 GB free');
  });

  it('carries on unchanged when there is room, without touching the server row', async () => {
    state.df = '40 20971520 /'; // 40% used, 20 GB free

    const { result } = await deploy();

    expect(result.error).toContain('Failed to clone repository');
    expect(state.updates).toEqual([]);
  });

  it('clears a stale disk-full status message once there is room again', async () => {
    state.df = '40 20971520 /';
    state.statusMessage = 'Disk full: 95% used, 0.5 GB free on / (…)';

    await deploy();

    expect(state.updates).toEqual([expect.objectContaining({ statusMessage: null })]);
  });

  it('leaves other status messages (billing, resizing) alone', async () => {
    state.df = '40 20971520 /';
    state.statusMessage = 'billing_suspended';

    await deploy();

    expect(state.updates).toEqual([]);
  });

  it('never cleans up when there is room', async () => {
    state.df = '40 20971520 /';

    await deploy();

    expect(cleanupScript()).toBeUndefined();
  });
});

describe('deployToRemoteServer: cleanup before refusing', () => {
  it('cleans up, measures again and carries on when that made room', async () => {
    state.dfQueue = ['94 2411724 /', '71 11534336 /']; // 94% / 2.3 GB free (the incident), then 71% / 11 GB
    state.cleanupOut = 'PUSHIFY_DEPLOY_CLEANUP before=40000000000 after=30872000000 containers=0 images=4';
    state.statusMessage = 'Disk full: 94% used, 2.3 GB free on / (…)';

    const { result, log } = await deploy();

    // Past the guard: the deploy went on to the clone
    expect(result.error).toContain('Failed to clone repository');
    expect(log).toContain('🧹 Disk cleanup freed 8.5 GB (removed 4 old image tag(s))');
    // The stale disk-full message is cleared, nothing else is written
    expect(state.updates).toEqual([expect.objectContaining({ statusMessage: null })]);

    const script = cleanupScript()!;
    expect(script).toContain('docker builder prune -af');
    expect(script).toContain('docker image prune -f');
    expect(script).not.toMatch(/system prune|volume|image prune -a/);
    // df measured twice: before and after the cleanup
    expect(state.commands.filter((c) => c.startsWith('df -P /'))).toHaveLength(2);
  });

  it('refuses when still full, with what was freed and what holds the disk — and no prune advice', async () => {
    state.dfQueue = ['94 2411724 /', '93 2621440 /'];
    state.cleanupOut = [
      'DF|Images|8GB',
      'DF|Local Volumes|30GB',
      'DF|Build Cache|0B',
      'DF|Containers|200MB',
      'PUSHIFY_DEPLOY_CLEANUP before=40000000000 after=39785000000 containers=0 images=0',
    ].join('\n');

    const { result, log } = await deploy();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Disk full: 93% used, 2\.5 GB free/);
    expect(result.error).toContain('Automatic cleanup freed 0.2 GB; largest on disk: Local Volumes 30GB, Images 8GB, Containers 200MB.');
    expect(result.error).toContain("See the server's health page for what holds the space, or resize the server");
    expect(result.error).not.toMatch(/docker system prune|--volumes/);
    expect(log).toContain('🧹 Disk cleanup freed 0.2 GB');
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ statusMessage: result.error, diskUsedPercent: 93 });
    expect(state.commands.some((c) => c.startsWith('git clone') || c.startsWith('mkdir'))).toBe(false);
  });

  it('keeps the running image, `latest` and the newest rollback images of every project', async () => {
    state.df = '95 1048576 /';
    const img = (n: number, tag: string) => `IMG|pushify-shop|${tag}|sha256:shop${n}|2026-11-0${n} 12:00:00 +0000 UTC`;
    state.inventory = [
      ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [img(n, `c${n}abcde`), img(n, `deploy-${n}0000000`)]),
      img(8, 'latest'),
      'USE|sha256:shop1', // the running container was rolled back to the oldest image
    ].join('\n');

    await deploy();

    const script = cleanupScript()!;
    const removed = [...script.matchAll(/'(pushify-shop:[^']+)'/g)].map((m) => m[1]);
    expect(removed.sort()).toEqual(['pushify-shop:c2abcde', 'pushify-shop:c3abcde', 'pushify-shop:deploy-20000000', 'pushify-shop:deploy-30000000']);
  });

  it('waits for a cleanup already running on the server instead of starting a second one', async () => {
    state.lockFree = false;
    state.dfQueue = ['92 1572864 /', '60 15728640 /'];

    const { result, log } = await deploy();

    expect(cleanupScript()).toBeUndefined();
    expect(log.some((l) => l.includes('Another disk cleanup is running on this server'))).toBe(true);
    expect(result.error).toContain('Failed to clone repository');
  });

  it('says so when the other cleanup was not enough either', async () => {
    state.lockFree = false;
    state.df = '92 1572864 /';

    const { result } = await deploy();

    expect(result.error).toContain('An automatic cleanup already ran on this server just now.');
  });
});
