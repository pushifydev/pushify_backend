import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { deployments } from '../db/schema/deployments';
import { classifyDeployFailure, type DeployFailureCategory } from '../lib/deploy-failure-classify';
import { isPolicyBlocked, removeFailurePrefix } from '../lib/deploy-failure-summary';
import { firstErrorLine } from '../lib/first-error-line';

/**
 * Re-runs the deploy failure classifier on each project's latest failed deploy that the worker
 * has not summarised yet: rows from before migration 0078 (no category), and rows classified
 * before the buildpack categories (0.6.1) or the failure summary (0079) existed. The growth
 * report reads the stored category, so without this a user stuck since then keeps showing as
 * 'unknown'. Run once with `npm run backfill:failure-category`.
 *
 * Idempotent: the verdict is computed from build_logs and error_message only, which this never
 * writes, and a row it filled is skipped the next time.
 */

export interface StoredFailure {
  id: string;
  errorMessage: string | null;
  buildLogs: string | null;
  failureCategory: string | null;
  failureSummary: string | null;
}

export interface FailureBackfillResult {
  /** Projects whose latest failed deploy was looked at */
  inspected: number;
  updated: number;
  /** New category of the updated rows */
  byCategory: Record<string, number>;
}

const PAGE_SIZE = 100;

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

/** The worker writes its verdict after the failure; the stored hint must not feed a new one. */
const VERDICT_TAG = /\[Pushify\] failureCategory=/;
const HINT_LINE = /^(?:\[[^\]]*\]\s*)?💡 /;

/** The log as the worker classified it: the lines before its failure verdict, without the hint. */
function logsBeforeVerdict(buildLogs: string | null): string {
  const lines = (buildLogs ?? '').split('\n');
  const tag = lines.findIndex((line) => VERDICT_TAG.test(line));
  return (tag === -1 ? lines : lines.slice(0, tag)).filter((line) => !HINT_LINE.test(line)).join('\n');
}

/** What the deploy worker stores today for this failure. */
export function reclassifyStoredFailure(row: Pick<StoredFailure, 'errorMessage' | 'buildLogs'>): {
  failureCategory: DeployFailureCategory;
  failureSummary: string | null;
} {
  const logs = logsBeforeVerdict(row.buildLogs);
  const rawError = removeFailurePrefix(row.errorMessage ?? '');
  return {
    failureCategory: classifyDeployFailure(logs, rawError).category,
    failureSummary: firstErrorLine(logs, rawError),
  };
}

export const deployFailureBackfillService = {
  async backfillLatestFailures(opts: { dryRun?: boolean } = {}): Promise<FailureBackfillResult> {
    const result: FailureBackfillResult = { inspected: 0, updated: 0, byCategory: {} };
    let cursor: string | null = null;

    for (;;) {
      const page: Array<StoredFailure & { projectId: string }> = await rows(sql`
        SELECT DISTINCT ON (project_id) id, project_id AS "projectId", error_message AS "errorMessage",
               build_logs AS "buildLogs", failure_category AS "failureCategory", failure_summary AS "failureSummary"
          FROM deployments
         WHERE status = 'failed' ${cursor ? sql`AND project_id > ${cursor}::uuid` : sql``}
         ORDER BY project_id, created_at DESC, id DESC
         LIMIT ${PAGE_SIZE}`);

      for (const row of page) {
        result.inspected += 1;
        // Policy stops are decided from the error type, which a stored row no longer has.
        if (isPolicyBlocked(row) || row.failureSummary !== null) continue;
        const next = reclassifyStoredFailure(row);
        if (next.failureCategory === row.failureCategory && next.failureSummary === null) continue;
        if (!opts.dryRun) {
          await db.update(deployments).set(next).where(eq(deployments.id, row.id));
        }
        result.updated += 1;
        result.byCategory[next.failureCategory] = (result.byCategory[next.failureCategory] ?? 0) + 1;
      }

      if (page.length < PAGE_SIZE) break;
      cursor = page[page.length - 1]!.projectId;
    }

    return result;
  },
};
