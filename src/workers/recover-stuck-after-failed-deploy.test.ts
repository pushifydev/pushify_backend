import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression for projects already stuck before the failed-deploy wake existed (a109b3b3): awake,
 * sleep-enabled, latest production deployment failed, old container stopped by the sweeper. The
 * worker start must find them and wake the previous container, and be safe to run again.
 */

type Row = Record<string, unknown>;
type Cond =
  | { op: 'eq'; col: string; val: unknown }
  | { op: 'isNull'; col: string }
  | { op: 'in'; col: string; vals: unknown[] }
  | { op: 'and'; conds: Cond[] };

const state: { projects: Row[]; deployments: Row[]; commands: string[]; startOk: boolean } = {
  projects: [],
  deployments: [],
  commands: [],
  startOk: true,
};

function matches(row: Row, cond: Cond | undefined): boolean {
  if (!cond) return true;
  switch (cond.op) {
    case 'and':
      return cond.conds.every((c) => matches(row, c));
    case 'eq':
      return row[cond.col] === cond.val;
    case 'isNull':
      return row[cond.col] == null;
    case 'in':
      return cond.vals.includes(row[cond.col]);
  }
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const orig = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...orig,
    eq: (col: { name: string }, val: unknown) => ({ op: 'eq', col: col.name, val }),
    isNull: (col: { name: string }) => ({ op: 'isNull', col: col.name }),
    inArray: (col: { name: string }, vals: unknown[]) => ({ op: 'in', col: col.name, vals }),
    and: (...conds: Cond[]) => ({ op: 'and', conds }),
    desc: (col: { name: string }) => ({ desc: col.name }),
  };
});

vi.mock('../db', async () => {
  const { projects } = await import('../db/schema/projects');
  const { deployments } = await import('../db/schema/deployments');
  const tableRows = (table: unknown) => (table === projects ? state.projects : table === deployments ? state.deployments : []);
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: (cond: Cond) => {
            const rows = () => tableRows(table).filter((r) => matches(r, cond));
            const p = Promise.resolve().then(rows) as Promise<Row[]> & {
              orderBy: (o: { desc: string }) => { limit: (n: number) => Promise<Row[]> };
              limit: (n: number) => Promise<Row[]>;
            };
            p.limit = async (n) => rows().slice(0, n);
            p.orderBy = (o) => ({
              limit: async (n) =>
                rows()
                  .sort((a, b) => (b[o.desc] as Date).getTime() - (a[o.desc] as Date).getTime())
                  .slice(0, n),
            });
            return p;
          },
        }),
      }),
      update: () => ({
        set: (patch: Row) => ({
          where: (cond: Cond) => {
            const hits = state.projects.filter((r) => matches(r, cond));
            for (const r of hits) {
              for (const [k, v] of Object.entries(patch)) r[k === 'sleepState' ? 'sleep_state' : k] = v;
            }
            const p = Promise.resolve(undefined) as Promise<unknown> & { returning: () => Promise<unknown[]> };
            p.returning = async () => hits.map((r) => ({ id: r.id }));
            return p;
          },
        }),
      }),
      query: {
        projects: {
          findFirst: async ({ where }: { where: Cond }) => {
            const p = state.projects.find((r) => matches(r, where));
            return p ? { ...p, sleepState: p.sleep_state } : undefined;
          },
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

const { findProjectsStuckAfterFailedDeploy, recoverProjectsStuckAfterFailedDeploy } = await import('./app-sleep.worker');

function proj(id: string, slug: string, extra: Row = {}): Row {
  return { id, slug, sleep_enabled: true, sleep_state: 'awake', status: 'active', suspended_at: null, ...extra };
}
function dep(projectId: string, status: string, minutesAgo: number, extra: Row = {}): Row {
  return {
    id: `${projectId}-${status}-${minutesAgo}`,
    project_id: projectId,
    status,
    environment: 'production',
    is_preview: false,
    created_at: new Date(Date.now() - minutesAgo * 60_000),
    ...extra,
  };
}

beforeEach(() => {
  state.commands = [];
  state.startOk = true;
  state.projects = [];
  state.deployments = [];
});

describe('startup repair: projects stuck awake after a failed deploy', () => {
  it('finds only awake sleep apps whose latest production deploy failed after one that served', async () => {
    state.projects = [
      proj('stuck', 'shop'),
      proj('healthy', 'blog'),
      proj('never-served', 'first'),
      proj('sleeping', 'nap', { sleep_state: 'sleeping' }),
      proj('no-sleep', 'always', { sleep_enabled: false }),
      proj('suspended', 'bad', { suspended_at: new Date() }),
      proj('redeploying', 'busy'),
      proj('preview-failed', 'pr'),
    ];
    state.deployments = [
      dep('stuck', 'running', 60),
      dep('stuck', 'failed', 10),
      dep('healthy', 'failed', 60),
      dep('healthy', 'running', 10),
      dep('never-served', 'failed', 10),
      dep('sleeping', 'running', 60),
      dep('sleeping', 'failed', 10),
      dep('no-sleep', 'running', 60),
      dep('no-sleep', 'failed', 10),
      dep('suspended', 'running', 60),
      dep('suspended', 'failed', 10),
      dep('redeploying', 'running', 60),
      dep('redeploying', 'failed', 10),
      dep('redeploying', 'building', 1),
      dep('preview-failed', 'running', 60),
      dep('preview-failed', 'failed', 10, { is_preview: true }),
    ];

    expect(await findProjectsStuckAfterFailedDeploy()).toEqual(['stuck']);
  });

  it('wakes the previous container and is idempotent on a second run', async () => {
    state.projects = [proj('stuck', 'shop')];
    state.deployments = [dep('stuck', 'running', 60), dep('stuck', 'failed', 10)];

    const first = await recoverProjectsStuckAfterFailedDeploy();
    expect(first).toEqual({ checked: 1, started: 1, failed: 0 });
    expect(state.commands).toHaveLength(1);
    expect(state.commands[0]).toContain('docker start');
    expect(state.commands[0]).toContain('pushify-shop');
    expect(state.projects[0].sleep_state).toBe('awake');
    expect(state.projects[0].lastWakeAt).toBeInstanceOf(Date);

    // Running again only re-issues a no-op `docker start` on running containers: same end state.
    const second = await recoverProjectsStuckAfterFailedDeploy();
    expect(second.failed).toBe(0);
    expect(state.projects[0].sleep_state).toBe('awake');
  });

  it('old container will not start: left sleeping so the next visit retries, and not picked again', async () => {
    state.projects = [proj('stuck', 'shop')];
    state.deployments = [dep('stuck', 'running', 60), dep('stuck', 'failed', 10)];
    state.startOk = false;

    vi.useFakeTimers();
    try {
      const pending = recoverProjectsStuckAfterFailedDeploy();
      await vi.advanceTimersByTimeAsync(35_000);
      expect(await pending).toEqual({ checked: 1, started: 0, failed: 1 });
    } finally {
      vi.useRealTimers();
    }
    expect(state.projects[0].sleep_state).toBe('sleeping');
    expect(await findProjectsStuckAfterFailedDeploy()).toEqual([]);
  });
});
