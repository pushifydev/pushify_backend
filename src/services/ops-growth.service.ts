import { sql } from 'drizzle-orm';
import { db } from '../db';
import { classifyDeployFailure } from '../lib/deploy-failure-classify';
import { scrubSecrets } from '../lib/ops-scrub';

/**
 * Growth signals for pushify-hq's growth agent: where new users stop between signing up and
 * paying, and why the ones who try to deploy get stuck. Aggregates only — no ids, names or
 * addresses leave — because the consumer hands it to a language model. Cancellation comments are
 * customer-written, so they go through scrubSecrets (which also removes e-mail addresses).
 */

export interface Funnel {
  registered: number;
  verified: number;
  createdProject: number;
  deployed: number;
  deploySucceeded: number;
  paid: number;
}

export interface OpsGrowth {
  generatedAt: string;
  funnel7d: Funnel;
  funnel30d: Funnel;
  /** Signed up in the last 14 days, created a project, never had a successful deploy. */
  stuck: {
    users: number;
    bySource: Array<{ source: string; users: number }>;
    byCause: Array<{ category: string; blame: string; label: string; users: number }>;
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
      rows<{ userId: string; source: string; errorMessage: string | null }>(sql`
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
               (SELECT d.error_message FROM deployments d WHERE d.project_id = up.project_id AND d.status = 'failed'
                 ORDER BY d.created_at DESC LIMIT 1) AS "errorMessage"
          FROM up
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
    const byCause = new Map<string, { category: string; blame: string; label: string; users: number }>();
    for (const s of stuckProjects) {
      bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1);
      const c = s.errorMessage
        ? classifyDeployFailure('', s.errorMessage)
        : { category: 'never_deployed', blame: 'project', label: 'Created a project but never deployed' };
      const cur = byCause.get(c.category) ?? { category: c.category, blame: c.blame, label: c.label, users: 0 };
      cur.users += 1;
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
