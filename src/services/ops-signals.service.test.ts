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
});
