import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({ queries: [] as unknown[], downRows: [] as unknown[], serverRows: [] as unknown[] }));

vi.mock('../db', () => ({
  db: {
    execute: async (query: unknown) => {
      h.queries.push(query);
      const text = JSON.stringify(query);
      if (text.includes('project_health_state')) return { rows: h.downRows };
      if (text.includes('disk_breakdown')) return { rows: h.serverRows };
      return { rows: [] };
    },
  },
}));

import { opsSignalsService } from './ops-signals.service';

const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as SQL).sql.replace(/\s+/g, ' ');

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
    expect(running.latestDeploy).toEqual({ status: 'running', createdAt: base.latestCreatedAt, blame: null, label: null, error: null });
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
