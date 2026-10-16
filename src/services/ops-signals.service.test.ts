import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({ queries: [] as unknown[], downRows: [] as unknown[] }));

vi.mock('../db', () => ({
  db: {
    execute: async (query: unknown) => {
      h.queries.push(query);
      const isDown = JSON.stringify(query).includes('project_health_state');
      return { rows: isDown ? h.downRows : [] };
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
    const { sitesDown, sitesDownUserCaused } = await opsSignalsService.getSignals();
    // The user-side build failure leaves the platform list and is only counted.
    expect(sitesDown.map((s) => s.projectId)).toEqual(['platform', 'running', 'none']);
    expect(sitesDownUserCaused).toEqual({ count: 1, projectIds: ['user'] });
    const [platform, running, none] = sitesDown;
    expect(platform.downReason).toBe('deploy_failed');
    expect(platform.latestDeploy).toMatchObject({ status: 'failed', blame: 'server', label: 'Out of memory' });
    expect(platform.latestDeploy?.error).toContain('Killed');
    expect(running.latestDeploy).toEqual({ status: 'running', createdAt: base.latestCreatedAt, blame: null, label: null, error: null });
    expect(none.downReason).toBeNull();
    expect(none.latestDeploy).toBeNull();
    expect(platform).not.toHaveProperty('latestStatus');
    expect(platform).not.toHaveProperty('latestError');
  });

  it('keeps a down site on the platform list when its failed build is the platform\'s (generic Docker build failure)', async () => {
    h.downRows = [
      {
        projectId: 'b1cecd19', downSince: '2026-09-22T22:54:41Z', statusCode: null, error: 'fetch failed', managed: true,
        serverStatus: 'running', serverLastSeenAt: null, lastSuccessfulDeployAt: null, ownerLastLoginAt: null,
        downReason: 'deploy_failed', latestStatus: 'failed', latestCreatedAt: '2026-09-22T22:50:00Z',
        latestError: '[Pushify] Docker build failed: failed to solve: process "/bin/sh -c apt-get install" did not complete',
      },
    ];
    const { sitesDown, sitesDownUserCaused } = await opsSignalsService.getSignals();
    expect(sitesDownUserCaused.count).toBe(0);
    expect(sitesDown[0].latestDeploy).toMatchObject({ blame: 'pushify', label: 'Docker build failed' });
    // The root cause travels with the entry, not just "fetch failed".
    expect(sitesDown[0].latestDeploy?.error).toContain('failed to solve');
  });
});
