import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Sleep + failed deploy: the deploy marks a sleeping app `awake` before it builds. If the build
 * fails, the old container is still stopped — without this recovery the project reads `awake`,
 * the wake endpoint answers a permanent 502 and nothing ever starts the container again.
 */

type Cond = { col: string; val: unknown } | { and: Cond[] };

const state: { project: Record<string, unknown>; commands: string[]; startOk: boolean } = {
  project: {},
  commands: [],
  startOk: true,
};

function matches(cond: Cond): boolean {
  if ('and' in cond) return cond.and.every(matches);
  return state.project[cond.col] === cond.val;
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const orig = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...orig,
    eq: (col: { name: string }, val: unknown) => ({ col: col.name, val }),
    and: (...conds: Cond[]) => ({ and: conds }),
  };
});

vi.mock('../db', () => {
  const toColumns = (patch: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) out[k === 'sleepState' ? 'sleep_state' : k] = v;
    return out;
  };
  return {
    db: {
      update: () => ({
        set: (patch: Record<string, unknown>) => ({
          where: (cond: Cond) => {
            const hit = matches(cond);
            if (hit) Object.assign(state.project, toColumns(patch));
            const p = Promise.resolve(undefined) as Promise<unknown> & { returning: () => Promise<unknown[]> };
            p.returning = async () => (hit ? [{ id: state.project.id }] : []);
            return p;
          },
        }),
      }),
      query: {
        projects: {
          findFirst: async () => ({ ...state.project, slug: state.project.slug, sleepState: state.project.sleep_state }),
        },
        servers: { findFirst: async () => ({ id: 'srv-1', ipv4: '203.0.113.10', sshPrivateKey: 'enc' }) },
      },
    },
  };
});
vi.mock('../lib/encryption', () => ({ decrypt: () => 'key' }));
vi.mock('../lib/runner-routing', () => ({ resolveProjectServerId: () => 'srv-1' }));
vi.mock('../utils/ssh', () => ({
  getSSHConnection: async () => ({
    exec: async (command: string) => {
      state.commands.push(command);
      return { code: state.startOk ? 0 : 1, stdout: '', stderr: '' };
    },
    disconnect() {},
  }),
}));

const { wakeAfterFailedDeploy } = await import('./app-sleep.worker');

beforeEach(() => {
  state.commands = [];
  state.startOk = true;
});

describe('wakeAfterFailedDeploy: a sleeping app whose deploy failed serves its old container again', () => {
  it('build failed after the deploy marked it awake: old container started, project awake', async () => {
    state.project = { id: 'proj-1', slug: 'shop', sleep_state: 'awake' };

    const result = await wakeAfterFailedDeploy('proj-1');

    expect(result).toBe('started');
    expect(state.commands).toHaveLength(1);
    expect(state.commands[0]).toContain('docker start');
    expect(state.commands[0]).toContain('pushify-shop');
    expect(state.project.sleep_state).toBe('awake');
    expect(state.project.lastWakeAt).toBeInstanceOf(Date);
  });

  it('old container will not start: left sleeping, so the next visit retries the wake (not a dead 502)', async () => {
    state.project = { id: 'proj-1', slug: 'shop', sleep_state: 'awake' };
    state.startOk = false;
    vi.useFakeTimers();
    try {
      const pending = wakeAfterFailedDeploy('proj-1');
      await vi.advanceTimersByTimeAsync(35_000);
      expect(await pending).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
    expect(state.project.sleep_state).toBe('sleeping');
  });

  it('a wake already in progress is not doubled', async () => {
    state.project = { id: 'proj-1', slug: 'shop', sleep_state: 'waking' };

    const result = await wakeAfterFailedDeploy('proj-1');

    expect(result).toBe('in-progress');
    expect(state.commands).toEqual([]);
  });
});
