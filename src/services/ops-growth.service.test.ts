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
import { FAILURE_SUMMARY_MAX_LENGTH } from '../lib/first-error-line';

const stuck = (row: Record<string, unknown>) => ({
  userId: 'u',
  source: 'buildpack',
  errorMessage: null,
  failureCategory: null,
  failureSummary: null,
  buildLogTail: null,
  ...row,
});

const ts = (line: string) => `[2026-09-22T10:00:00.000Z] ${line}`;
/** A buildpack deploy stored before 0.6.1: an npm 10 failure filed as a generic "Deployment failed". */
const npmLog = [
  ts('🔨 Building Docker image: pushify-app:abc1234'),
  ts('#9 [builder 4/8] RUN npm ci'),
  ts('#9 1.204 npm error code ERESOLVE'),
  ts('#9 1.205 npm error ERESOLVE unable to resolve dependency tree'),
  ts('[Pushify] failureCategory=unknown'),
  ts('💡 Review the full deploy log. Fix errors in your app or contact support with the deployment ID.'),
  ts('❌ Deployment failed: Remote deployment failed'),
].join('\n');
/** A failure no classifier case knows, printing secrets on its error line. */
const oddLog = [
  ts('#11 [builder 5/8] RUN npm run build'),
  ts(`#11 1.2 Error: weird-tool could not parse weird.config, secret=hunter2hunter2 token sk_live_abcdefghijklmnop ${'x'.repeat(400)}`),
  ts('#11 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1'),
].join('\n');
const remoteFailed = '[Project] Deployment failed: Remote deployment failed';

describe('opsGrowthService stuck users', () => {
  beforeEach(() => {
    h.stuckRows = [];
    h.queries = [];
  });

  it("reads each stuck user's newest failed deploy with its stored category and summary", async () => {
    await opsGrowthService.getGrowth();
    const query = h.queries.find((q) => q.includes('AS "failureSummary"'))!;
    expect(query).toContain('fd.failure_category AS "failureCategory"');
    expect(query).toContain('right(d.build_logs, $1::int) AS build_log_tail');
    expect(query).toContain("d.status = 'failed' ORDER BY d.created_at DESC LIMIT 1) fd ON true");
  });

  it('takes the category the worker stored over re-classifying the message', async () => {
    // The message alone ("Docker build failed") would land in docker_build.
    h.stuckRows = [
      stuck({
        errorMessage: '[Pushify] Docker build failed: Docker build failed',
        failureCategory: 'dependency_install',
        failureSummary: 'npm error code ETARGET',
        buildLogTail: oddLog,
      }),
    ];
    const { stuck: report } = await opsGrowthService.getGrowth();
    expect(report.byCause).toEqual([
      { category: 'dependency_install', blame: 'project', label: 'Dependency install failed', users: 1, sample: 'npm error code ETARGET' },
    ]);
  });

  it('classifies an old buildpack failure stored without a category from its log tail, without writing it back', async () => {
    h.stuckRows = [stuck({ errorMessage: remoteFailed, buildLogTail: npmLog })];
    const { stuck: report } = await opsGrowthService.getGrowth();
    expect(report.byCause).toEqual([
      { category: 'dependency_install', blame: 'project', label: 'Dependency install failed', users: 1, sample: 'npm error code ERESOLVE' },
    ]);
    expect(h.queries.every((q) => !/\b(?:UPDATE|INSERT|DELETE)\b/i.test(q))).toBe(true);
  });

  it("classifies again a row an older classifier stored as 'unknown', from its stored first error line", async () => {
    h.stuckRows = [stuck({ errorMessage: remoteFailed, failureCategory: 'unknown', failureSummary: 'npm error code ERESOLVE' })];
    const { stuck: report } = await opsGrowthService.getGrowth();
    expect(report.byCause).toMatchObject([{ category: 'dependency_install', users: 1, sample: 'npm error code ERESOLVE' }]);
  });

  it("keeps a still-unknown failure unknown and gives its first error line from the log, masked and capped", async () => {
    h.stuckRows = [stuck({ errorMessage: remoteFailed, failureCategory: 'unknown', buildLogTail: oddLog })];
    const { stuck: report } = await opsGrowthService.getGrowth();
    const [unknown] = report.byCause;
    expect(unknown).toMatchObject({ category: 'unknown', label: 'Deployment failed', users: 1 });
    expect(unknown.sample).toContain('Error: weird-tool could not parse weird.config');
    expect(unknown.sample).not.toContain('hunter2');
    expect(unknown.sample).not.toContain('sk_live_abcdefghijklmnop');
    expect(unknown.sample!.length).toBeLessThanOrEqual(FAILURE_SUMMARY_MAX_LENGTH + 1);
  });

  it('gives a policy stop no first error line', async () => {
    h.stuckRows = [stuck({ errorMessage: '[Project] Stopped by policy: This deploy was stopped', failureCategory: 'policy_blocked', buildLogTail: oddLog })];
    const { stuck: report } = await opsGrowthService.getGrowth();
    expect(report.byCause).toMatchObject([{ category: 'policy_blocked', users: 1, sample: null }]);
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
