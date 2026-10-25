import { sql } from 'drizzle-orm';
import { db } from '../db';
import { classifyDeployFailure, describeFailureCategory } from '../lib/deploy-failure-classify';
import { FAILURE_SUMMARY_MAX_LENGTH } from '../lib/first-error-line';
import { scrubSecrets } from '../lib/ops-scrub';
import { reclassifyStoredFailure } from './deploy-failure-backfill.service';

/**
 * Growth signals for pushify-hq's growth agent: where new users stop between signing up and
 * paying, and why the ones who try to deploy get stuck. Aggregates only — no ids, names or
 * addresses leave — because the consumer hands it to a language model. Cancellation comments are
 * customer-written, so they go through scrubSecrets (which also removes e-mail addresses), and so
 * does the one build-log error line given per stuck cause.
 */

export interface Funnel {
  registered: number;
  verified: number;
  createdProject: number;
  deployed: number;
  deploySucceeded: number;
  paid: number;
}

export interface StuckCause {
  category: string;
  blame: string;
  label: string;
  users: number;
  /**
   * First error line of one of these users' newest failed deploy, scrubbed and capped:
   * deployments.failure_summary, or read from the log tail for rows stored without one.
   */
  sample: string | null;
}

export interface OpsGrowth {
  generatedAt: string;
  funnel7d: Funnel;
  funnel30d: Funnel;
  /** Signed up in the last 14 days, created a project, never had a successful deploy. */
  stuck: {
    users: number;
    bySource: Array<{ source: string; users: number }>;
    byCause: StuckCause[];
  };
  /** Signed up 2–14 days ago and never created a project. */
  noProject: number;
  cancellations30d: {
    byReason: Array<{ reason: string; count: number }>;
    recentComments: Array<{ reason: string; comment: string }>;
  };
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

interface StuckRow {
  userId: string;
  source: string;
  errorMessage: string | null;
  failureCategory: string | null;
  failureSummary: string | null;
  /** The end of the failed deploy's build_logs (BUILD_LOG_TAIL_CHARS) */
  buildLogTail: string | null;
}

/** Enough of the log for the failing step and the worker's failureCategory= line after it. */
const BUILD_LOG_TAIL_CHARS = 20_000;

const NEVER_DEPLOYED = { category: 'never_deployed', blame: 'project', label: 'Created a project but never deployed' };

interface Cause {
  category: string;
  blame: string;
  label: string;
  /** Scrubbed and capped */
  firstErrorLine: string | null;
}

/**
 * The category the deploy worker (or the backfill) stored, read with the log behind it; the
 * message alone often says only "Docker build failed". A row stored without a category or as
 * 'unknown' (an older classifier) is classified again from its first error line and log tail, as
 * the backfill would, and a row without a stored first error line gets one from the log. Only
 * read here: nothing is written back.
 */
function stuckCause(row: StuckRow): Cause {
  const stored = row.failureCategory ? describeFailureCategory(row.failureCategory) : null;
  const known = stored?.category === 'unknown' ? null : stored;
  const storedLine = scrubSecrets(row.failureSummary, FAILURE_SUMMARY_MAX_LENGTH);
  // The worker gives policy stops no first error line.
  if (known?.category === 'policy_blocked') return { ...known, firstErrorLine: null };
  if (known && storedLine) return { ...known, firstErrorLine: storedLine };
  if (!row.errorMessage && !row.failureSummary && !row.buildLogTail) {
    return { ...(stored ?? NEVER_DEPLOYED), firstErrorLine: null };
  }

  const reread = reclassifyStoredFailure({
    errorMessage: row.errorMessage,
    buildLogs: [row.failureSummary, row.buildLogTail].filter(Boolean).join('\n'),
  });
  const cause =
    known ??
    (reread.failureCategory !== 'unknown'
      ? describeFailureCategory(reread.failureCategory)!
      : classifyDeployFailure('', row.errorMessage ?? ''));
  return { category: cause.category, blame: cause.blame, label: cause.label, firstErrorLine: storedLine ?? reread.failureSummary };
}

function funnelFor(days: number) {
  const since = sql.raw(`interval '${days} days'`);
  return rows<Funnel>(sql`
    WITH u AS (SELECT id, email_verified FROM users WHERE created_at > now() - ${since}),
         uo AS (SELECT DISTINCT m.user_id, m.organization_id FROM organization_members m JOIN u ON u.id = m.user_id)
    SELECT
      (SELECT count(*) FROM u)::int AS "registered",
      (SELECT count(*) FROM u WHERE email_verified)::int AS "verified",
      (SELECT count(DISTINCT uo.user_id) FROM uo JOIN projects p ON p.organization_id = uo.organization_id)::int AS "createdProject",
      (SELECT count(DISTINCT uo.user_id) FROM uo JOIN projects p ON p.organization_id = uo.organization_id
         JOIN deployments d ON d.project_id = p.id)::int AS "deployed",
      (SELECT count(DISTINCT uo.user_id) FROM uo JOIN projects p ON p.organization_id = uo.organization_id
         JOIN deployments d ON d.project_id = p.id WHERE d.status IN ('running', 'stopped'))::int AS "deploySucceeded",
      (SELECT count(DISTINCT uo.user_id) FROM uo JOIN organizations o ON o.id = uo.organization_id
         WHERE o.plan <> 'free')::int AS "paid"`).then((r) => r[0]!);
}

export const opsGrowthService = {
  async getGrowth(): Promise<OpsGrowth> {
    const [funnel7d, funnel30d, stuckProjects, noProject, reasons, comments] = await Promise.all([
      funnelFor(7),
      funnelFor(30),
      // One row per stuck user: their newest project's kind and newest failure.
      rows<StuckRow>(sql`
        WITH cohort AS (SELECT id FROM users WHERE created_at > now() - interval '14 days'),
             up AS (
               SELECT DISTINCT ON (m.user_id) m.user_id, p.id AS project_id,
                      CASE WHEN p.docker_image IS NOT NULL THEN 'image'
                           WHEN p.compose_path IS NOT NULL THEN 'compose'
                           WHEN p.dockerfile_path IS NOT NULL THEN 'dockerfile'
                           ELSE 'buildpack' END AS source
                 FROM organization_members m
                 JOIN cohort c ON c.id = m.user_id
                 JOIN projects p ON p.organization_id = m.organization_id
                ORDER BY m.user_id, p.created_at DESC
             )
        SELECT up.user_id AS "userId", up.source,
               fd.error_message AS "errorMessage", fd.failure_category AS "failureCategory",
               fd.failure_summary AS "failureSummary", fd.build_log_tail AS "buildLogTail"
          FROM up
          LEFT JOIN LATERAL (SELECT d.error_message, d.failure_category, d.failure_summary,
                                    right(d.build_logs, ${BUILD_LOG_TAIL_CHARS}::int) AS build_log_tail
                               FROM deployments d WHERE d.project_id = up.project_id AND d.status = 'failed'
                              ORDER BY d.created_at DESC LIMIT 1) fd ON true
         WHERE NOT EXISTS (
           SELECT 1 FROM organization_members m2 JOIN projects p2 ON p2.organization_id = m2.organization_id
             JOIN deployments d2 ON d2.project_id = p2.id
            WHERE m2.user_id = up.user_id AND d2.status IN ('running', 'stopped'))`),
      rows<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM users u
         WHERE u.created_at < now() - interval '2 days' AND u.created_at > now() - interval '14 days'
           AND NOT EXISTS (SELECT 1 FROM organization_members m JOIN projects p ON p.organization_id = m.organization_id
                            WHERE m.user_id = u.id)`),
      rows<{ reason: string; count: number }>(sql`
        SELECT reason, count(*)::int AS count FROM cancellation_feedback
         WHERE created_at > now() - interval '30 days' GROUP BY reason ORDER BY count DESC`),
      rows<{ reason: string; comment: string }>(sql`
        SELECT reason, comment FROM cancellation_feedback
         WHERE created_at > now() - interval '30 days' AND comment IS NOT NULL AND comment <> ''
         ORDER BY created_at DESC LIMIT 10`),
    ]);

    const bySource = new Map<string, number>();
    const byCause = new Map<string, StuckCause>();
    for (const s of stuckProjects) {
      bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1);
      const c = stuckCause(s);
      const cur = byCause.get(c.category) ?? { category: c.category, blame: c.blame, label: c.label, users: 0, sample: null };
      cur.users += 1;
      cur.sample ??= c.firstErrorLine;
      byCause.set(c.category, cur);
    }

    return {
      generatedAt: new Date().toISOString(),
      funnel7d,
      funnel30d,
      stuck: {
        users: stuckProjects.length,
        bySource: [...bySource].map(([source, users]) => ({ source, users })).sort((a, b) => b.users - a.users),
        byCause: [...byCause.values()].sort((a, b) => b.users - a.users),
      },
      noProject: noProject[0]?.n ?? 0,
      cancellations30d: {
        byReason: reasons,
        recentComments: comments.map((c) => ({ reason: c.reason, comment: scrubSecrets(c.comment, 300) ?? '' })),
      },
    };
  },
};
