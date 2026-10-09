import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * nginx sends a 502 to /api/v1/wake/:slug. A first deploy whose build failed has never had a
 * container, so the visitor should read "deployment failed", not a crash ("not responding").
 */

const state: {
  project: Record<string, unknown> | undefined;
  /** Rows returned by successive db.select() chains: [latest], then [ever served] */
  selects: Array<Array<Record<string, unknown>>>;
} = { project: undefined, selects: [] };

vi.mock('../db', () => {
  const chain = () => {
    const rows = state.selects.shift() ?? [];
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy']) c[m] = () => c;
    c.limit = async () => rows;
    return c;
  };
  return {
    db: {
      query: { projects: { findFirst: vi.fn(async () => state.project) } },
      select: vi.fn(() => chain()),
    },
  };
});
vi.mock('../workers/app-sleep.worker', () => ({ requestWake: vi.fn(async () => 'started') }));
vi.mock('../middleware/auth', () => ({ authMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()) }));
vi.mock('../repositories/organization.repository', () => ({ organizationRepository: {} }));
vi.mock('../repositories/project.repository', () => ({ projectRepository: {} }));

const { wakeRoutes } = await import('./wake');
const { requestWake } = await import('../workers/app-sleep.worker');

const awake = { id: 'proj-1', slug: 'shop', sleepEnabled: false, sleepState: 'awake' };

beforeEach(() => {
  state.selects = [];
});

describe('wake endpoint: what a visitor sees when the app has no container', () => {
  it('first deploy failed to build: "Deployment failed" (503), not a crash page', async () => {
    state.project = awake;
    state.selects = [[{ status: 'failed' }], []];

    const res = await wakeRoutes.request('/shop');

    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain('Deployment failed');
    expect(body).not.toContain('not responding');
  });

  it('latest deploy failed but an earlier one ran: generic unavailable page (runtime problem)', async () => {
    state.project = awake;
    state.selects = [[{ status: 'failed' }], [{ id: 'dep-old' }]];

    const res = await wakeRoutes.request('/shop');

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('Application unavailable');
  });

  it('latest deploy is running: generic unavailable page', async () => {
    state.project = awake;
    state.selects = [[{ status: 'running' }]];

    const res = await wakeRoutes.request('/shop');

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('Application unavailable');
  });

  it('sleeping app whose latest deploy failed: the old container is woken, not "Deployment failed"', async () => {
    state.project = { id: 'proj-1', slug: 'shop', sleepEnabled: true, sleepState: 'sleeping' };
    state.selects = [[{ status: 'failed' }], [{ id: 'dep-old' }]];

    const res = await wakeRoutes.request('/shop');

    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Waking up');
    expect(requestWake).toHaveBeenCalledWith('proj-1');
  });

  it('unknown slug: generic unavailable page', async () => {
    state.project = undefined;

    const res = await wakeRoutes.request('/nope');

    expect(res.status).toBe(502);
  });
});

describe('wake endpoint: suspended projects', () => {
  it('shows a neutral "suspended" page, never wakes the app and never says why', async () => {
    vi.mocked(requestWake).mockClear();
    state.project = {
      id: 'proj-2',
      slug: 'relay',
      sleepEnabled: true,
      sleepState: 'sleeping',
      suspendedAt: new Date(),
      suspensionReason: 'Runs a VLESS relay',
    };

    const res = await wakeRoutes.request('/relay');

    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain('This app is suspended');
    expect(body).not.toContain('VLESS');
    expect(requestWake).not.toHaveBeenCalled();
  });
});
