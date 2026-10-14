import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A deploy onto a host that is (nearly) out of disk is refused before anything is cloned,
 * pulled or started, with the reason in the deploy log and on the server's status message.
 */

const state: { df: string; commands: string[]; updates: Array<Record<string, unknown>>; statusMessage: string | null } = {
  df: '',
  commands: [],
  updates: [],
  statusMessage: null,
};

vi.mock('../utils/ssh', () => {
  class FakeSSHClient {
    async connect() {}
    disconnect() {}
    async exec(command: string) {
      state.commands.push(command);
      if (command === 'docker --version') return { code: 0, stdout: 'Docker version 24.0.5', stderr: '' };
      if (command.startsWith('df -P /')) return { code: 0, stdout: state.df, stderr: '' };
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
});

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
});
