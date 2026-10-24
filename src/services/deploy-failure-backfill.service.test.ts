import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

interface Row {
  id: string;
  projectId: string;
  errorMessage: string | null;
  buildLogs: string | null;
  failureCategory: string | null;
  failureSummary: string | null;
}

const dialect = new PgDialect();

const h = vi.hoisted(() => ({
  /** The latest failed deploy of each project, as the DISTINCT ON query returns them */
  rows: [] as Row[],
  queries: [] as string[],
  writes: [] as Array<{ id: unknown; values: Record<string, unknown> }>,
}));

vi.mock('../db', () => ({
  db: {
    execute: async (query: SQL) => {
      h.queries.push(dialect.sqlToQuery(query).sql.replace(/\s+/g, ' '));
      return { rows: h.rows.map((r) => ({ ...r })) };
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async (where: SQL) => {
          const id = dialect.sqlToQuery(where).params[0];
          h.writes.push({ id, values });
          Object.assign(h.rows.find((r) => r.id === id)!, values);
        },
      }),
    }),
  },
}));

import { deployFailureBackfillService, reclassifyStoredFailure } from './deploy-failure-backfill.service';

const ts = (line: string) => `[2026-09-22T10:00:00.000Z] ${line}`;
/** What the worker stored before 0.6.1: an npm 10 failure it filed as a generic "Deployment failed". */
const npmLog = [
  ts('🔨 Building Docker image: pushify-app:abc1234'),
  ts('#9 [builder 4/8] RUN npm ci'),
  ts('#9 1.204 npm error code ERESOLVE'),
  ts('#9 1.205 npm error ERESOLVE unable to resolve dependency tree'),
  ts('[Pushify] failureCategory=unknown'),
  ts('💡 Review the full deploy log. Fix errors in your app or contact support with the deployment ID.'),
  ts('❌ Deployment failed: Remote deployment failed'),
].join('\n');
/** A failure no classifier case knows. */
const oddLog = [
  ts('#11 [builder 5/8] RUN npm run build'),
  ts('#11 1.2 Error: weird-tool could not parse weird.config (line 3), secret=hunter2hunter2'),
  ts('#11 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1'),
].join('\n');

const base = { failureCategory: null, failureSummary: null };

describe('reclassifyStoredFailure', () => {
  it('reads the log, not the stored verdict, and summarises the first error line', () => {
    expect(reclassifyStoredFailure({ buildLogs: npmLog, errorMessage: '[Project] Deployment failed: Remote deployment failed' })).toEqual({
      failureCategory: 'dependency_install',
      failureSummary: 'npm error code ERESOLVE',
    });
  });

  it('leaves an unmatched log unknown, with a summary that does not show the secret', () => {
    const next = reclassifyStoredFailure({ buildLogs: oddLog, errorMessage: '[Project] Deployment failed: Remote deployment failed' });
    expect(next.failureCategory).toBe('unknown');
    expect(next.failureSummary).toContain('weird-tool could not parse weird.config');
    expect(next.failureSummary).not.toContain('hunter2');
  });
});

describe('deployFailureBackfillService.backfillLatestFailures', () => {
  beforeEach(() => {
    h.rows = [
      { id: 'd1', projectId: 'p1', errorMessage: '[Project] Deployment failed: Remote deployment failed', buildLogs: npmLog, ...base },
      { id: 'd2', projectId: 'p2', errorMessage: '[Project] Deployment failed: Remote deployment failed', buildLogs: oddLog, failureCategory: 'unknown', failureSummary: null },
      {
        id: 'd3', projectId: 'p3', errorMessage: '[Project] Stopped by policy: This deploy was stopped', buildLogs: 'npm error code ERESOLVE',
        failureCategory: 'policy_blocked', failureSummary: null,
      },
      {
        id: 'd4', projectId: 'p4', errorMessage: '[Project] Dependency install failed: x', buildLogs: oddLog,
        failureCategory: 'dependency_install', failureSummary: 'npm error code ETARGET',
      },
    ];
    h.queries = [];
    h.writes = [];
  });

  it("selects each project's latest failed deploy", async () => {
    await deployFailureBackfillService.backfillLatestFailures();
    expect(h.queries[0]).toContain("SELECT DISTINCT ON (project_id)");
    expect(h.queries[0]).toContain("WHERE status = 'failed'");
    expect(h.queries[0]).toContain('ORDER BY project_id, created_at DESC, id DESC');
  });

  it('re-classifies rows without a summary, and leaves policy stops and worker-summarised rows alone', async () => {
    const result = await deployFailureBackfillService.backfillLatestFailures();
    expect(result).toEqual({ inspected: 4, updated: 2, byCategory: { dependency_install: 1, unknown: 1 } });
    expect(h.writes.map((w) => w.id)).toEqual(['d1', 'd2']);
    expect(h.rows.find((r) => r.id === 'd2')).toMatchObject({ failureCategory: 'unknown', failureSummary: expect.stringContaining('weird-tool') });
    expect(h.rows.find((r) => r.id === 'd3')).toMatchObject({ failureCategory: 'policy_blocked', failureSummary: null });
    expect(h.rows.find((r) => r.id === 'd4')).toMatchObject({ failureCategory: 'dependency_install', failureSummary: 'npm error code ETARGET' });
  });

  it('is idempotent: a second run on the same rows changes nothing', async () => {
    await deployFailureBackfillService.backfillLatestFailures();
    const after = structuredClone(h.rows);
    h.writes = [];
    const second = await deployFailureBackfillService.backfillLatestFailures();
    expect(second.updated).toBe(0);
    expect(h.writes).toEqual([]);
    expect(h.rows).toEqual(after);
  });

  it('a dry run counts but writes nothing', async () => {
    const result = await deployFailureBackfillService.backfillLatestFailures({ dryRun: true });
    expect(result.updated).toBe(2);
    expect(h.writes).toEqual([]);
  });
});
