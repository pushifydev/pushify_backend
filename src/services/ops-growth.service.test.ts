import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q).sql.replace(/\s+/g, ' ');

const h = vi.hoisted(() => ({
  stuckRows: [] as unknown[],
  queries: [] as string[],
}));

vi.mock('../db', () => ({
  db: {
    execute: async (query: SQL) => {
      const text = render(query);
      h.queries.push(text);
      if (text.includes('AS "failureSummary"')) return { rows: h.stuckRows };
      return { rows: [] };
    },
  },
}));

import { opsGrowthService } from './ops-growth.service';

const stuck = (row: Record<string, unknown>) => ({
  userId: 'u',
  source: 'buildpack',
  errorMessage: null,
  failureCategory: null,
  failureSummary: null,
  ...row,
});

describe('opsGrowthService stuck users', () => {
  beforeEach(() => {
    h.stuckRows = [];
    h.queries = [];
  });

  it("reads each stuck user's newest failed deploy with its stored category and summary", async () => {
    await opsGrowthService.getGrowth();
    const query = h.queries.find((q) => q.includes('AS "failureSummary"'))!;
    expect(query).toContain('fd.failure_category AS "failureCategory"');
    expect(query).toContain("d.status = 'failed' ORDER BY d.created_at DESC LIMIT 1) fd ON true");
  });

  it('takes the category the worker stored over re-classifying the message', async () => {
    // The message alone ("Docker build failed") would land in docker_build.
    h.stuckRows = [stuck({ errorMessage: '[Pushify] Docker build failed: Docker build failed', failureCategory: 'dependency_install' })];
    const { stuck: report } = await opsGrowthService.getGrowth();
    expect(report.byCause).toEqual([
      { category: 'dependency_install', blame: 'project', label: 'Dependency install failed', users: 1, sample: null },
    ]);
  });

  it("gives an unknown failure's first error line, scrubbed, next to the category", async () => {
    h.stuckRows = [
      stuck({
        errorMessage: '[Project] Deployment failed: Remote deployment failed',
        failureCategory: 'unknown',
        failureSummary: 'Error: weird-tool rejected API_KEY=sk_live_abcdefghijklmnop for owner@example.com',
      }),
      stuck({ userId: 'u2', errorMessage: '[Project] Deployment failed: Remote deployment failed', failureCategory: 'unknown' }),
    ];
    const { stuck: report } = await opsGrowthService.getGrowth();
    expect(report.byCause).toHaveLength(1);
    const [unknown] = report.byCause;
    expect(unknown).toMatchObject({ category: 'unknown', label: 'Deployment failed', users: 2 });
    expect(unknown.sample).toContain('Error: weird-tool rejected');
    expect(unknown.sample).not.toContain('sk_live_abcdefghijklmnop');
    expect(unknown.sample).not.toContain('owner@example.com');
  });

  it('re-classifies the message of rows from before the category was stored, and counts never-deployed users', async () => {
    h.stuckRows = [
      stuck({ errorMessage: '[Project] Deployment failed: npm error code ERESOLVE' }),
      stuck({ userId: 'u2', failureCategory: 'not_a_category', errorMessage: '[Server] Disk full: ENOSPC' }),
      stuck({ userId: 'u3' }),
    ];
    const { stuck: report } = await opsGrowthService.getGrowth();
    expect(report.byCause.map((c) => c.category).sort()).toEqual(['dependency_install', 'disk_space', 'never_deployed']);
  });
});
