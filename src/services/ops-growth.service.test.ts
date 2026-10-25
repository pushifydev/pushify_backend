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
  buildLogsTail: null,
  ...row,
});

const ts = (line: string) => `[2026-09-22T10:00:00.000Z] ${line}`;
/** An npm 10 buildpack failure stored before 0.6.1 and never backfilled: no category, no summary. */
const npmLog = [
  ts('🔨 Building Docker image: pushify-app:abc1234'),
  ts('#9 [builder 4/8] RUN npm ci'),
  ts('#9 1.204 npm error code ERESOLVE'),
  ts('#9 1.205 npm error ERESOLVE unable to resolve dependency tree'),
  ts('[Pushify] failureCategory=unknown'),
  ts('💡 Review the full deploy log. Fix errors in your app or contact support with the deployment ID.'),
  ts('❌ Deployment failed: Remote deployment failed'),
].join('\n');
/** A failure no classifier case knows, printing a secret. */
const oddLog = [
  ts('#11 [builder 5/8] RUN npm run build'),
  ts('#11 1.2 Error: weird-tool rejected API_KEY=sk_live_abcdefghijklmnop for owner@example.com'),
  ts('#11 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1'),
].join('\n');
const REMOTE_FAILED = '[Project] Deployment failed: Remote deployment failed';

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

  it('reads the build log tail only for rows it re-classifies', async () => {
    await opsGrowthService.getGrowth();
    const query = h.queries.find((q) => q.includes('AS "failureSummary"'))!;
    expect(query).toContain('fd.build_logs_tail AS "buildLogsTail"');
    expect(query).toContain(
      "CASE WHEN d.failure_category IS NULL OR d.failure_category = 'unknown' OR (d.failure_summary IS NULL AND d.failure_category <> 'policy_blocked') THEN right(d.build_logs, $1) END AS build_logs_tail",
    );
  });

  it('gives an old buildpack failure without category or summary a concrete category and first error line from its log', async () => {
    h.stuckRows = [stuck({ errorMessage: REMOTE_FAILED, buildLogsTail: npmLog })];
    const { stuck: report } = await opsGrowthService.getGrowth();
    expect(report.byCause).toEqual([
      { category: 'dependency_install', blame: 'project', label: 'Dependency install failed', users: 1, sample: 'npm error code ERESOLVE' },
    ]);
  });

  it("re-classifies a stored 'unknown' from its log tail", async () => {
    h.stuckRows = [stuck({ errorMessage: REMOTE_FAILED, failureCategory: 'unknown', buildLogsTail: npmLog })];
    const { stuck: report } = await opsGrowthService.getGrowth();
    expect(report.byCause).toMatchObject([{ category: 'dependency_install', users: 1, sample: 'npm error code ERESOLVE' }]);
  });

  it('keeps a stored concrete category and fills its missing first error line from the log', async () => {
    h.stuckRows = [stuck({ errorMessage: REMOTE_FAILED, failureCategory: 'runtime_version', buildLogsTail: npmLog })];
    const { stuck: report } = await opsGrowthService.getGrowth();
    expect(report.byCause).toMatchObject([{ category: 'runtime_version', users: 1, sample: 'npm error code ERESOLVE' }]);
  });

  it('still unknown: returns the first error line of the log, with the secret masked', async () => {
    h.stuckRows = [stuck({ errorMessage: REMOTE_FAILED, buildLogsTail: oddLog })];
    const { stuck: report } = await opsGrowthService.getGrowth();
    expect(report.byCause).toHaveLength(1);
    const [unknown] = report.byCause;
    expect(unknown).toMatchObject({ category: 'unknown', label: 'Deployment failed', users: 1 });
    expect(unknown.sample).toContain('Error: weird-tool rejected');
    expect(unknown.sample).not.toContain('sk_live_abcdefghijklmnop');
    expect(unknown.sample).not.toContain('owner@example.com');
  });

  it('skips the line right() may have cut at the start of a full-size tail', async () => {
    // The end of a line right() cut, which reads like an error.
    const tail = `module could not be found\n${npmLog}`.padStart(20_000, 'x');
    h.stuckRows = [stuck({ errorMessage: REMOTE_FAILED, buildLogsTail: tail })];
    const { stuck: report } = await opsGrowthService.getGrowth();
    expect(report.byCause[0]!.sample).toBe('npm error code ERESOLVE');
  });

  it('gives no error line for a policy stop', async () => {
    h.stuckRows = [stuck({ errorMessage: '[Project] Stopped by policy: This deploy was stopped', failureCategory: 'policy_blocked' })];
    const { stuck: report } = await opsGrowthService.getGrowth();
    expect(report.byCause).toEqual([{ category: 'policy_blocked', blame: 'project', label: 'Stopped by policy', users: 1, sample: null }]);
  });

  it('takes the category the worker stored over re-classifying the message', async () => {
    // The message alone ("Docker build failed") would land in docker_build.
    h.stuckRows = [stuck({ errorMessage: '[Pushify] Docker build failed: Docker build failed', failureCategory: 'dependency_install' })];
    const { stuck: report } = await opsGrowthService.getGrowth();
    expect(report.byCause).toEqual([
      // No summary stored: the raw error is its first error line, as the worker would store it today.
      { category: 'dependency_install', blame: 'project', label: 'Dependency install failed', users: 1, sample: 'Docker build failed' },
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
