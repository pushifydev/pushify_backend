import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  queries: [] as unknown[],
  downRows: [] as unknown[],
  stoppedRows: [] as unknown[],
  serverRows: [] as unknown[],
  outcomeRows: [] as unknown[],
  sinceRows: [] as unknown[],
}));

vi.mock('../db', () => ({
  db: {
    execute: async (query: unknown) => {
      h.queries.push(query);
      const text = JSON.stringify(query);
      if (text.includes('project_health_state') && text.includes("p.status <> 'active'")) return { rows: h.stoppedRows };
      if (text.includes('project_health_state')) return { rows: h.downRows };
      if (text.includes('disk_breakdown')) return { rows: h.serverRows };
      if (text.includes('GROUP BY 1, 2')) return { rows: h.outcomeRows };
      if (text.includes('LIMIT 2000')) return { rows: h.sinceRows };
      return { rows: [] };
    },
  },
}));

import { opsSignalsService, projectStopCategory } from './ops-signals.service';

const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as SQL).sql.replace(/\s+/g, ' ');
const downQuery = () => h.queries.map(render).find((q) => q.includes('project_health_state') && !q.includes("p.status <> 'active'"));
const stoppedQuery = () => h.queries.map(render).find((q) => q.includes('project_health_state') && q.includes("p.status <> 'active'"));

describe('opsSignalsService sitesDown query', () => {
  beforeEach(() => {
    h.queries = [];
    h.downRows = [];
  });

  it('only lists down sites that monitoring still checks, so a stale row cannot linger', async () => {
    await opsSignalsService.getSignals();
    const query = h.queries.map(render).find((q) => q.includes('project_health_state'));
    expect(query).toBeDefined();
    expect(query).toContain("h.status = 'down'");
    // Same filter as appHealthService.candidates(): active, awake, has a URL and a running deployment.
    expect(query).toContain('JOIN projects p ON p.id = h.project_id');
    expect(query).toContain("p.status = 'active'");
    expect(query).toContain("p.sleep_state = 'awake'");
    // Suspended (or owner-paused) projects were stopped on purpose: never a down site.
    expect(query).toContain('p.suspended_at IS NULL');
    expect(query).toContain("jsonb_typeof(p.settings -> 'productionUrl') = 'string'");
    expect(query).toContain("EXISTS (SELECT 1 FROM deployments d WHERE d.project_id = h.project_id AND d.status = 'running')");
  });

  it('leaves a project in maintenance mode out: its 503 page says nothing about the app', async () => {
    await opsSignalsService.getSignals();
    expect(downQuery()).toContain("AND (p.maintenance_mode ->> 'enabled') IS DISTINCT FROM 'true'");
  });

  it('carries the facts needed to classify a down site as platform or user side', async () => {
    await opsSignalsService.getSignals();
    const query = h.queries.map(render).find((q) => q.includes('project_health_state'))!;
    expect(query).toContain('LEFT JOIN servers s ON s.id = p.server_id');
    expect(query).toContain('s.is_managed AS "managed"');
    expect(query).toContain('"serverLastSeenAt"');
    expect(query).toContain("d.status IN ('running', 'stopped')");
    expect(query).toContain("m.role = 'owner'");
    expect(query).toContain("e.event IN ('login', 'register')");
  });

  it('maps the server to a hosting kind and never passes the raw managed flag through', async () => {
    const base = {
      downSince: '2026-09-22T00:00:00Z', statusCode: 502, error: 'Bad gateway',
      serverStatus: 'running', serverLastSeenAt: null, lastSuccessfulDeployAt: null, ownerLastLoginAt: null,
    };
    h.downRows = [
      { ...base, projectId: 'a', managed: false },
      { ...base, projectId: 'b', managed: true },
      { ...base, projectId: 'c', managed: null, serverStatus: null },
    ];
    const { sitesDown } = await opsSignalsService.getSignals();
    expect(sitesDown.map((s) => s.hosting)).toEqual(['byos', 'managed', 'shared']);
    expect(sitesDown[0]).not.toHaveProperty('managed');
    expect(sitesDown[0]).toMatchObject({ projectId: 'a', statusCode: 502, serverStatus: 'running' });
  });

  it('selects the down reason and the latest deployment for each down site', async () => {
    await opsSignalsService.getSignals();
    const query = h.queries.map(render).find((q) => q.includes('project_health_state'))!;
    expect(query).toContain('h.down_reason AS "downReason"');
    expect(query).toContain('LEFT JOIN LATERAL');
    expect(query).toContain('ORDER BY d.created_at DESC LIMIT 1) ld ON true');
  });

  it('classifies a failed latest build so a user-side build failure is not a platform outage', async () => {
    const base = {
      downSince: '2026-09-22T22:54:41Z', statusCode: null, error: 'fetch failed', managed: true,
      serverStatus: 'running', serverLastSeenAt: null, lastSuccessfulDeployAt: '2026-09-01T00:00:00Z', ownerLastLoginAt: null,
      latestCreatedAt: '2026-09-22T22:50:00Z',
    };
    h.downRows = [
      { ...base, projectId: 'user', downReason: 'deploy_failed', latestStatus: 'failed',
        latestError: "[Project] Application build failed: Failed to compile.\n./src/app.tsx Type error" },
      { ...base, projectId: 'platform', downReason: 'deploy_failed', latestStatus: 'failed',
        latestError: '[Server] Out of memory: Killed' },
      { ...base, projectId: 'running', downReason: 'app_error', latestStatus: 'running', latestError: null },
      { ...base, projectId: 'none', downReason: undefined, latestStatus: null, latestCreatedAt: null, latestError: null },
    ];
    const { sitesDown } = await opsSignalsService.getSignals();
    const [user, platform, running, none] = sitesDown;
    expect(user.downReason).toBe('deploy_failed');
    expect(user.latestDeploy).toMatchObject({ status: 'failed', blame: 'project', label: 'Application build failed' });
    expect(user.latestDeploy?.error).toContain('Failed to compile.');
    expect(user.latestDeploy?.error).not.toContain('Type error');
    expect(platform.latestDeploy).toMatchObject({ status: 'failed', blame: 'server' });
    expect(user.latestDeploy?.category).toBe('application_build');
    expect(running.latestDeploy).toEqual({
      status: 'running', createdAt: base.latestCreatedAt, category: null, blame: null, label: null, error: null, firstErrorLine: null,
    });
    expect(none.downReason).toBeNull();
    expect(none.latestDeploy).toBeNull();
    expect(user).not.toHaveProperty('latestStatus');
    expect(user).not.toHaveProperty('latestError');
  });
});

describe('opsSignalsService sitesDown diagnosis', () => {
  beforeEach(() => {
    h.queries = [];
    h.downRows = [];
  });

  it('diagnoses from the health check and server checks, not from a failed build alone', async () => {
    h.downRows = [
      {
        projectId: 'b1cecd19', downSince: '2026-09-22T22:54:41Z', statusCode: null, error: 'fetch failed', managed: true,
        serverStatus: 'running', serverLastSeenAt: null, lastSuccessfulDeployAt: null, ownerLastLoginAt: null,
        downReason: 'deploy_failed', latestStatus: 'failed', latestCreatedAt: '2026-09-22T22:50:00Z',
        latestError: '[Project] Docker build failed: exit code 1',
        diagnostics: {
          checkedAt: '2026-10-16T00:00:00Z', failedCheck: 'ssh', advice: null, managed: true,
          checks: [{ check: 'ssh', outcome: 'timeout', ok: false, advice: null }],
        },
      },
    ];
    const { sitesDown } = await opsSignalsService.getSignals();
    expect(sitesDown[0].diagnosis).toMatchObject({ kind: 'unreachable', userSide: false });
    expect(sitesDown[0]).not.toHaveProperty('diagnostics');
    const query = h.queries.map(render).find((q) => q.includes('project_health_state'))!;
    expect(query).toContain('h.diagnostics AS "diagnostics"');
  });

  it("moves a user's powered-off or unreachable own server out of sitesDown, so it raises no platform alarm", async () => {
    const base = {
      downSince: '2026-09-22T22:54:41Z', statusCode: null, error: 'fetch failed', serverLastSeenAt: null,
      lastSuccessfulDeployAt: null, ownerLastLoginAt: null, downReason: 'server_unreachable',
      latestStatus: 'running', latestCreatedAt: '2026-09-01T00:00:00Z', latestError: null,
      diagnostics: {
        checkedAt: '2026-10-16T00:00:00Z', failedCheck: 'ssh', advice: null, managed: true,
        checks: [{ check: 'ssh', outcome: 'timeout', ok: false, advice: null }],
      },
    };
    h.downRows = [
      { ...base, projectId: 'stopped', managed: true, serverStatus: 'stopped', serverStatusMessage: 'billing_suspended' },
      { ...base, projectId: 'byos', managed: false, serverStatus: 'running', serverStatusMessage: null },
      { ...base, projectId: 'ours', managed: true, serverStatus: 'running', serverStatusMessage: null },
    ];
    const { sitesDown, userServerUnreachable } = await opsSignalsService.getSignals();
    expect(sitesDown.map((s) => s.projectId)).toEqual(['ours']);
    expect(sitesDown[0].diagnosis).toMatchObject({ kind: 'unreachable', userSide: false });
    expect(userServerUnreachable.map((s) => s.projectId)).toEqual(['stopped', 'byos']);
    expect(userServerUnreachable[0]).toMatchObject({ hosting: 'managed', serverStatus: 'stopped', diagnosis: { kind: 'user_server_unreachable', userSide: true } });
    expect(userServerUnreachable[0].diagnosis.summary).toContain('stopped for non-payment');
    expect(userServerUnreachable[1]).toMatchObject({ hosting: 'byos', diagnosis: { kind: 'user_server_unreachable', userSide: true } });
    expect(userServerUnreachable[0]).not.toHaveProperty('serverStatusMessage');
    const query = h.queries.map(render).find((q) => q.includes('project_health_state'))!;
    expect(query).toContain('s.status_message AS "serverStatusMessage"');
  });
});

describe('opsSignalsService sitesDown stored failure and container facts', () => {
  beforeEach(() => {
    h.queries = [];
    h.downRows = [];
  });

  // b1cecd19: ECONNREFUSED, no HTTP status, the latest deploy a failed build.
  const base = {
    projectId: 'b1cecd19', downSince: '2026-09-22T22:54:41Z', statusCode: null, error: 'fetch failed (ECONNREFUSED)',
    managed: true, serverStatus: 'running', serverLastSeenAt: null, lastSuccessfulDeployAt: '2026-09-01T00:00:00Z',
    ownerLastLoginAt: null, downReason: 'app_error', latestStatus: 'failed', latestCreatedAt: '2026-09-22T22:50:00Z',
    latestError: '[Pushify] Docker build failed: exit code 1',
  };
  const exited = {
    checkedAt: '2026-10-22T09:00:00.000Z', cause: 'container_exited', hint: 'Check its last log lines', state: 'exited',
    name: 'pushify-secret-slug', exitCode: 1, restartCount: 0, oomKilled: false, finishedAt: '2026-09-22T22:53:10Z',
    configuredPort: 3000, listeningPorts: null, loopbackPorts: null, logTail: 'DATABASE_URL=postgres://u:p@db/app',
  };

  it('selects the stored failure category and first error line of the latest deployment', async () => {
    await opsSignalsService.getSignals();
    const query = h.queries.map(render).find((q) => q.includes('project_health_state'))!;
    expect(query).toContain('d.failure_category, d.failure_summary');
    expect(query).toContain('ld.failure_category AS "latestFailureCategory"');
    expect(query).toContain('ld.failure_summary AS "latestFailureSummary"');
  });

  it('gives the stored category, its first error line scrubbed, and the inspected container without name or logs', async () => {
    h.downRows = [
      {
        ...base,
        latestFailureCategory: 'application_build',
        latestFailureSummary: 'Error: STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop is not set',
        diagnostics: { checkedAt: '2026-10-22T09:00:00.000Z', checks: [], failedCheck: null, advice: null, managed: true, container: exited },
      },
    ];
    const { sitesDown, userDeployFailed } = await opsSignalsService.getSignals();
    // A failed build on the project's side with no container running: user side, not a platform outage.
    expect(sitesDown).toEqual([]);
    const [site] = userDeployFailed;
    // The stored category wins over the message ("Docker build failed" would say docker_build, pushify side).
    expect(site.latestDeploy).toMatchObject({
      status: 'failed', createdAt: base.latestCreatedAt, category: 'application_build', blame: 'project', label: 'Application build failed',
    });
    expect(site.latestDeploy?.firstErrorLine).toContain('STRIPE_SECRET_KEY=[redacted]');
    expect(site.latestDeploy?.firstErrorLine).not.toContain('sk_live_');
    expect(site.lastSuccessfulDeployAt).toBe('2026-09-01T00:00:00Z');
    expect(site.diagnosis).toMatchObject({ kind: 'build_failed', userSide: true, cause: 'container_exited' });
    expect(site.diagnosis.container).toEqual({
      state: 'exited', cause: 'container_exited', checkedAt: '2026-10-22T09:00:00.000Z', exitCode: 1, restartCount: 0,
      oomKilled: false, configuredPort: 3000, listeningPorts: null, loopbackPorts: null,
    });
    expect(JSON.stringify(site)).not.toMatch(/pushify-secret-slug|postgres:|Check its last log lines/);
    expect(site).not.toHaveProperty('latestFailureCategory');
    expect(site).not.toHaveProperty('latestFailureSummary');
  });

  it('falls back to the message when the stored category is missing or unknown', async () => {
    h.downRows = [
      { ...base, projectId: 'old', latestFailureCategory: null, latestFailureSummary: null },
      { ...base, projectId: 'unknown', latestFailureCategory: 'unknown', latestFailureSummary: 'boom' },
      { ...base, projectId: 'nothing', latestError: 'something odd', latestFailureCategory: 'unknown', latestFailureSummary: null },
    ];
    const { sitesDown } = await opsSignalsService.getSignals();
    const [old, unknown, nothing] = sitesDown;
    expect(old.latestDeploy).toMatchObject({ status: 'failed', category: 'docker_build', blame: 'pushify', firstErrorLine: null });
    expect(unknown.latestDeploy).toMatchObject({ category: 'docker_build', firstErrorLine: 'boom' });
    expect(nothing.latestDeploy).toMatchObject({ status: 'failed', category: 'unknown', label: 'Deployment failed' });
  });

  it("says 'unknown' when the container was not inspected, and does not fail on a record it cannot read", async () => {
    h.downRows = [
      { ...base, projectId: 'none', diagnostics: null },
      { ...base, projectId: 'uninspected', diagnostics: { checkedAt: 'x', checks: [], failedCheck: null, advice: null, managed: true, container: { state: 'unknown', cause: null } } },
      { ...base, projectId: 'broken', diagnostics: { checks: 'not-a-list', failedCheck: 'http_port', container: { state: 42, listeningPorts: 'x' } } },
    ];
    const { sitesDown } = await opsSignalsService.getSignals();
    const [none, uninspected, broken] = sitesDown;
    for (const site of sitesDown) {
      expect(site.latestDeploy).toMatchObject({ status: 'failed', category: 'docker_build' });
      expect(site.diagnosis.container).toMatchObject({ state: 'unknown', cause: null, listeningPorts: null });
    }
    expect(none.diagnosis.kind).toBe('container_not_running');
    expect(uninspected.diagnosis.summary).toContain('could not be inspected');
    expect(broken.diagnosis).toMatchObject({ kind: 'unknown', userSide: null });
  });
});

describe('opsSignalsService user side: deploy failed', () => {
  beforeEach(() => {
    h.queries = [];
    h.downRows = [];
  });

  // b1cecd19: ECONNREFUSED, the latest deploy a failed build on the project's side.
  const base = {
    downSince: '2026-09-22T22:54:41Z', statusCode: null, error: 'fetch failed (ECONNREFUSED)', managed: true,
    serverStatus: 'running', serverStatusMessage: null, serverLastSeenAt: null, lastSuccessfulDeployAt: '2026-09-01T00:00:00Z',
    ownerLastLoginAt: null, downReason: 'app_error', latestStatus: 'failed', latestCreatedAt: '2026-09-22T22:50:00Z',
    latestError: '[Project] Application build failed: npm ERR! Missing script: "build"', latestFailureCategory: 'application_build',
  };
  const inspected = (container: Record<string, unknown>) => ({
    checkedAt: '2026-10-22T09:00:00.000Z', checks: [], failedCheck: null, advice: null, managed: true,
    container: { checkedAt: '2026-10-22T09:00:00.000Z', exitCode: 1, restartCount: 0, oomKilled: false, configuredPort: 3000, listeningPorts: null, loopbackPorts: null, ...container },
  });

  it('does not count a failed build with no version running as an outage', async () => {
    h.downRows = [
      { ...base, projectId: 'b1cecd19', diagnostics: inspected({ state: 'exited', cause: 'container_exited' }) },
      { ...base, projectId: 'missing', diagnostics: inspected({ state: 'missing', cause: null }) },
      { ...base, projectId: 'bad-gateway', statusCode: 502, error: 'Bad gateway', diagnostics: null },
    ];
    const { sitesDown, userServerUnreachable, userDeployFailed } = await opsSignalsService.getSignals();
    expect(sitesDown).toEqual([]);
    expect(userServerUnreachable).toEqual([]);
    expect(userDeployFailed.map((s) => s.projectId)).toEqual(['b1cecd19', 'missing', 'bad-gateway']);
    for (const site of userDeployFailed) {
      expect(site.diagnosis).toMatchObject({ kind: 'build_failed', userSide: true });
      expect(site.latestDeploy).toMatchObject({ status: 'failed', category: 'application_build', blame: 'project' });
    }
  });

  it('still raises the alarm for a real outage of a project that had a successful version', async () => {
    h.downRows = [
      // The server running the previous version does not answer: Pushify's, whatever the build did.
      {
        ...base, projectId: 'unreachable',
        diagnostics: { checkedAt: '2026-10-22T09:00:00.000Z', failedCheck: 'ssh', advice: null, managed: true, checks: [{ check: 'ssh', outcome: 'timeout', ok: false, advice: null }] },
      },
      // The container could not be inspected: nothing says the build is why.
      { ...base, projectId: 'uninspected', diagnostics: inspected({ state: 'unknown', cause: null }) },
      // The previous version runs but crash-loops: the app's own cause, not the failed build.
      { ...base, projectId: 'crash-loop', diagnostics: inspected({ state: 'restarting', cause: 'crash_loop', restartCount: 40 }) },
      // A failed build blamed on Pushify stays a platform candidate.
      { ...base, projectId: 'pushify-build', latestError: '[Pushify] Docker build failed: exit code 1', latestFailureCategory: 'docker_build', diagnostics: inspected({ state: 'exited', cause: 'container_exited' }) },
      // The latest deploy succeeded, yet its container is down.
      { ...base, projectId: 'deployed', latestStatus: 'running', latestError: null, latestFailureCategory: null, diagnostics: inspected({ state: 'exited', cause: 'container_exited' }) },
    ];
    const { sitesDown, userDeployFailed } = await opsSignalsService.getSignals();
    expect(userDeployFailed).toEqual([]);
    expect(sitesDown.map((s) => s.projectId)).toEqual(['unreachable', 'uninspected', 'crash-loop', 'pushify-build', 'deployed']);
    expect(sitesDown.every((s) => s.lastSuccessfulDeployAt === base.lastSuccessfulDeployAt)).toBe(true);
    expect(sitesDown[0].diagnosis).toMatchObject({ kind: 'unreachable', userSide: false });
    expect(sitesDown.slice(1).map((s) => s.diagnosis.kind)).toEqual(Array(4).fill('container_not_running'));
  });
});

describe('opsSignalsService projects stopped on purpose', () => {
  beforeEach(() => {
    h.queries = [];
    h.downRows = [];
    h.stoppedRows = [];
  });

  // A 'down' stored before the project stopped: monitoring no longer checks it, so it stays.
  const stale = {
    downSince: '2026-09-22T22:54:41Z', statusCode: null, error: 'fetch failed (ECONNREFUSED)', managed: true,
    serverStatus: 'running', serverLastSeenAt: null, lastSuccessfulDeployAt: '2026-09-01T00:00:00Z', ownerLastLoginAt: null,
    downReason: 'app_error', latestStatus: 'failed', latestCreatedAt: '2026-09-22T22:50:00Z',
    latestError: '[Pushify] Docker build failed: exit code 1', diagnostics: null,
  };
  const serving = { projectStatus: 'active', sleepState: 'awake', suspended: false, maintenance: false };
  const states = {
    paused: { ...serving, projectStatus: 'paused' },
    suspended: { ...serving, projectStatus: 'paused', suspended: true },
    sleeping: { ...serving, sleepState: 'sleeping' },
    maintenance: { ...serving, maintenance: true },
    deleted: { ...serving, projectStatus: 'deleted' },
  };

  it('raises no down-site signal for a stopped, suspended, sleeping, in-maintenance or deleted project', async () => {
    h.downRows = [
      ...Object.entries(states).map(([projectId, state]) => ({ ...stale, ...state, projectId })),
      { ...stale, ...serving, projectId: 'live' },
    ];
    const { sitesDown, userServerUnreachable } = await opsSignalsService.getSignals();
    expect(sitesDown.map((s) => s.projectId)).toEqual(['live']);
    expect(userServerUnreachable).toEqual([]);
    expect(sitesDown[0]).not.toHaveProperty('projectStatus');
    expect(sitesDown[0]).not.toHaveProperty('suspended');
    expect(sitesDown[0]).not.toHaveProperty('maintenance');
  });

  it('lists them in sitesStopped with why, and b1cecd19 suspended under the policy is policy_suspended, not down', async () => {
    h.stoppedRows = [
      { projectId: 'b1cecd19', downSince: stale.downSince, ...states.suspended },
      { projectId: 'paused', downSince: '2026-10-01T00:00:00Z', ...states.paused },
      { projectId: 'sleeping', downSince: '2026-10-02T00:00:00Z', ...states.sleeping },
      { projectId: 'waking', downSince: null, ...serving, sleepState: 'waking' },
      { projectId: 'maintenance', downSince: '2026-10-03T00:00:00Z', ...states.maintenance },
      { projectId: 'deleted', downSince: '2026-10-04T00:00:00Z', ...states.deleted },
      // Not stopped after all (it would be monitored): never listed as stopped.
      { projectId: 'live', downSince: '2026-10-05T00:00:00Z', ...serving },
    ];
    const { sitesDown, sitesStopped } = await opsSignalsService.getSignals();
    expect(sitesDown).toEqual([]);
    expect(sitesStopped).toEqual([
      { projectId: 'b1cecd19', downSince: stale.downSince, category: 'policy_suspended' },
      { projectId: 'paused', downSince: '2026-10-01T00:00:00Z', category: 'stopped_by_user' },
      { projectId: 'sleeping', downSince: '2026-10-02T00:00:00Z', category: 'sleeping' },
      { projectId: 'waking', downSince: null, category: 'sleeping' },
      { projectId: 'maintenance', downSince: '2026-10-03T00:00:00Z', category: 'maintenance' },
      { projectId: 'deleted', downSince: '2026-10-04T00:00:00Z', category: 'deleted' },
    ]);
  });

  it('reads the down rows that the sitesDown filter leaves out, by the project state only', async () => {
    await opsSignalsService.getSignals();
    const query = stoppedQuery();
    expect(query).toBeDefined();
    expect(query).toContain("WHERE h.status = 'down'");
    expect(query).toContain(
      "AND (p.status <> 'active' OR p.sleep_state <> 'awake' OR p.suspended_at IS NOT NULL OR (p.maintenance_mode ->> 'enabled') = 'true')"
    );
    expect(query).toContain('(p.suspended_at IS NOT NULL) AS "suspended"');
    expect(query).toContain(`coalesce((p.maintenance_mode ->> 'enabled') = 'true', false) AS "maintenance"`);
    expect(query).not.toMatch(/h\.error|diagnostics|auth_events/);
    // The down-site query reads the same columns, so one rule decides what counts as stopped.
    expect(downQuery()).toContain('p.status::text AS "projectStatus", p.sleep_state AS "sleepState"');
  });

  it('projectStopCategory: a suspension wins over the pause it comes with; a serving project is not stopped', () => {
    expect(projectStopCategory(states.suspended)).toBe('policy_suspended');
    expect(projectStopCategory({ ...states.deleted, sleepState: 'sleeping' })).toBe('deleted');
    expect(projectStopCategory({ ...states.paused, maintenance: true })).toBe('stopped_by_user');
    expect(projectStopCategory({ ...states.sleeping, maintenance: true })).toBe('sleeping');
    expect(projectStopCategory(states.maintenance)).toBe('maintenance');
    expect(projectStopCategory(serving)).toBeNull();
    // A row without the state columns (an older reader) is treated as serving, as before.
    expect(projectStopCategory({})).toBeNull();
  });
});

describe('opsSignalsService servers disk diagnosis', () => {
  beforeEach(() => {
    h.queries = [];
    h.downRows = [];
    h.serverRows = [];
  });

  const base = {
    serverId: 's1', managed: true, provider: 'hetzner', status: 'running', setupStatus: 'completed',
    diskUsedPercent: 86, message: null,
  };

  it('shows what holds a full disk, and whether it is customer data', async () => {
    h.serverRows = [
      {
        ...base,
        diskBreakdown: {
          measuredAt: '2026-10-16T00:00:00.000Z', usedBytes: 33e9, totalBytes: 38e9,
          imagesBytes: 4e9, buildCacheBytes: 0, containersBytes: 1e6, logsBytes: 6e7, volumesBytes: 25e9,
          heldBy: 'volumes', userData: true, uncappedLogContainers: 3,
          cleanup: { freedBytes: 1e9, logsTruncatedBytes: 9e8, rotatedLogContainers: 2, daemonConfig: 'present' },
        },
      },
    ];
    const { servers } = await opsSignalsService.getSignals();
    expect(servers[0]).toMatchObject({
      serverId: 's1',
      problem: 'disk',
      disk: { heldBy: 'volumes', userData: true, volumesBytes: 25e9, imagesBytes: 4e9, logsBytes: 6e7, uncappedLogContainers: 3, lastCleanupFreedBytes: 1e9 },
    });
    expect(servers[0]).not.toHaveProperty('diskBreakdown');
  });

  it('reports no diagnosis before the first cleanup', async () => {
    h.serverRows = [{ ...base, diskBreakdown: null }];
    const { servers } = await opsSignalsService.getSignals();
    expect(servers[0].disk).toBeNull();
  });
});

describe('opsSignalsService deploy failure rate', () => {
  beforeEach(() => {
    h.queries = [];
    h.outcomeRows = [];
    h.sinceRows = [];
  });

  it('counts deploys stopped under the Acceptable Use Policy on their own line, out of total and failed', async () => {
    // 7 deploys, 5 stopped by the policy: the alarm read 5/7 failed.
    h.outcomeRows = [
      { status: 'failed', failureCategory: 'policy_blocked', count: 5 },
      { status: 'running', failureCategory: null, count: 2 },
    ];
    const { deployments } = await opsSignalsService.getSignals();
    expect(deployments).toMatchObject({ total: 2, failed: 0, policyBlocked: 5 });
  });

  it('still reports real failures next to them', async () => {
    h.outcomeRows = [
      { status: 'failed', failureCategory: 'policy_blocked', count: 3 },
      { status: 'failed', failureCategory: 'application_build', count: 1 },
      { status: 'failed', failureCategory: null, count: 1 },
      { status: 'running', failureCategory: null, count: 3 },
    ];
    const { deployments } = await opsSignalsService.getSignals();
    expect(deployments).toMatchObject({ total: 5, failed: 2, policyBlocked: 3 });
  });

  it('keeps them out of the failure causes and the failing projects', async () => {
    await opsSignalsService.getSignals();
    const rendered = h.queries.map(render);
    const causes = rendered.find((q) => q.includes('ORDER BY created_at DESC LIMIT 500'));
    expect(causes).toContain("status = 'failed' AND failure_category IS DISTINCT FROM 'policy_blocked'");
    const failing = rendered.find((q) => q.includes('WITH recent AS'));
    expect(failing).toContain("failure_category IS DISTINCT FROM 'policy_blocked'");
  });

  it('applies the same rule to the deploy watch window', async () => {
    h.sinceRows = [
      { status: 'failed', failureCategory: 'policy_blocked', errorMessage: '[Project] Stopped by policy: stopped' },
      { status: 'failed', failureCategory: 'docker_build', errorMessage: '[Pushify] Docker build failed: failed to solve' },
      { status: 'running', failureCategory: null, errorMessage: null },
    ];
    const { since } = await opsSignalsService.getSignals({ since: new Date(Date.now() - 60_000) });
    expect(since).toMatchObject({ total: 2, failed: 1, pushifyFailed: 1, policyBlocked: 1 });
  });
});
