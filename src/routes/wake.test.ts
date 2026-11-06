import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * nginx sends a 502 to /api/v1/wake/p/:projectId (older vhosts: /api/v1/wake/:slug). A first
 * deploy whose build failed has never had a container, so the visitor should read "deployment
 * failed", not a crash ("not responding").
 */

const state: {
  project: Record<string, unknown> | undefined;
  /** Rows the slug lookup returns; defaults to [project] */
  slugMatches: Array<Record<string, unknown>> | undefined;
  /** The where clause of every projects lookup, in order */
  wheres: unknown[];
  /** Rows returned by successive db.select() chains: [latest], then [ever served] */
  selects: Array<Array<Record<string, unknown>>>;
} = { project: undefined, slugMatches: undefined, wheres: [], selects: [] };

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
      query: {
        projects: {
          findFirst: vi.fn(async (q: { where: unknown }) => {
            state.wheres.push(q.where);
            return state.project;
          }),
          findMany: vi.fn(async (q: { where: unknown }) => {
            state.wheres.push(q.where);
            return state.slugMatches ?? (state.project ? [state.project] : []);
          }),
        },
      },
      select: vi.fn(() => chain()),
    },
  };
});
vi.mock('../workers/app-sleep.worker', () => ({ requestWake: vi.fn(async () => 'started') }));
vi.mock('../middleware/auth', () => ({ authMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()) }));
vi.mock('../repositories/organization.repository', () => ({ organizationRepository: {} }));
vi.mock('../repositories/project.repository', () => ({ projectRepository: {} }));
vi.mock('../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { wakeRoutes } = await import('./wake');
const { requestWake } = await import('../workers/app-sleep.worker');
const { db } = await import('../db');
const { logger } = await import('../lib/logger');

const dialect = new PgDialect();
const lastLookup = () => dialect.sqlToQuery(state.wheres[state.wheres.length - 1] as SQL);

const awake = { id: 'proj-1', slug: 'shop', sleepEnabled: false, sleepState: 'awake' };

beforeEach(() => {
  state.project = undefined;
  state.slugMatches = undefined;
  state.wheres = [];
  state.selects = [];
  vi.mocked(requestWake).mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(db.query.projects.findFirst).mockClear();
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

/**
 * A slug is only unique within an organization: two organizations with their own servers can
 * both have an `api`. The vhost names the project by id; a slug is acted on only when it is
 * unambiguous, and a deleted project never answers.
 */
const ORG_A_PROJECT = { id: '11111111-1111-4111-8111-111111111111', slug: 'api', sleepEnabled: false, sleepState: 'awake' };
const ORG_B_PROJECT = { id: '22222222-2222-4222-8222-222222222222', slug: 'api', sleepEnabled: true, sleepState: 'sleeping' };

describe('wake endpoint: by project id', () => {
  it('wakes exactly the sleeping project the vhost names, looked up by id among non-deleted projects', async () => {
    state.project = ORG_B_PROJECT;

    const res = await wakeRoutes.request(`/p/${ORG_B_PROJECT.id}`);

    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Waking up');
    expect(requestWake).toHaveBeenCalledWith(ORG_B_PROJECT.id);
    const lookup = lastLookup();
    expect(lookup.sql).toContain('"id" = $1');
    expect(lookup.sql).toMatch(/"status" <> \$2/);
    expect(lookup.params).toEqual([ORG_B_PROJECT.id, 'deleted']);
  });

  it('a deleted project (not found by the lookup) gets the generic unavailable page', async () => {
    state.project = undefined;

    const res = await wakeRoutes.request(`/p/${ORG_A_PROJECT.id}`);

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('Application unavailable');
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('an id that is not a uuid never reaches the database', async () => {
    const res = await wakeRoutes.request('/p/not-a-uuid');

    expect(res.status).toBe(502);
    expect(db.query.projects.findFirst).not.toHaveBeenCalled();
  });
});

describe('wake endpoint: by slug (vhosts written before the id route)', () => {
  it('two organizations share the slug: neither is woken, the visitor gets the generic page', async () => {
    state.slugMatches = [ORG_A_PROJECT, ORG_B_PROJECT];

    const res = await wakeRoutes.request('/api');

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('Application unavailable');
    expect(requestWake).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith({ slug: 'api' }, expect.any(String));
  });

  it("another organization's suspended project never shows its suspended page on a shared slug", async () => {
    state.slugMatches = [{ ...ORG_A_PROJECT, suspendedAt: new Date() }, ORG_B_PROJECT];

    const res = await wakeRoutes.request('/api');

    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('suspended');
  });

  it('deleted projects are left out of the lookup, so one live match is still woken', async () => {
    state.slugMatches = [ORG_B_PROJECT];

    const res = await wakeRoutes.request('/api');

    expect(res.status).toBe(503);
    expect(requestWake).toHaveBeenCalledWith(ORG_B_PROJECT.id);
    const lookup = lastLookup();
    expect(lookup.sql).toContain('"slug" = $1');
    expect(lookup.sql).toMatch(/"status" <> \$2/);
    expect(lookup.params).toEqual(['api', 'deleted']);
  });
});
