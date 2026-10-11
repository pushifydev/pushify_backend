import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({ queries: [] as unknown[] }));

vi.mock('../db', () => ({
  db: {
    execute: async (query: unknown) => {
      h.queries.push(query);
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
});
