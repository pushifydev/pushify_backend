import { sql } from 'drizzle-orm';
import { db } from '../db';
import { classifyDeployFailure, type DeployFailureBlame } from '../lib/deploy-failure-classify';
import { stripFailurePrefix, summarizeDeployFailures } from '../lib/deploy-failure-summary';
import { scrubSecrets } from '../lib/ops-scrub';

/**
 * Operational signals for the operations agent (pushify-hq). Read-only and platform-wide.
 *
 * What goes out is chosen for what an on-call engineer needs to notice a problem and nothing
 * more: ids, states, counts, times, and error text passed through scrubSecrets. No names,
 * emails, IPs, repositories, env vars or logs — the consumer is a bot whose output reaches a
 * language model, and it can look a project up in the admin panel by id if it needs more.
 */

const WINDOW_HOURS = 24;
const DISK_WARN_PERCENT = 85;
const SITE_DOWN_GRACE_MIN = 5;
const LIST_LIMIT = 50;

export interface OpsSignals {
  generatedAt: string;
  windowHours: number;
  /**
   * Deployments started after `since` (when asked): the operations agent's deploy watch compares
   * the minutes after a Pushify release with the day before it.
   */
  since: { since: string; total: number; failed: number; pushifyFailed: number } | null;
  deployments: {
    total: number;
    failed: number;
    /** Failures grouped by cause, with whose fault each cause is. */
    causes: Array<{ category: string; blame: DeployFailureBlame; label: string; count: number; projects: number; sample: string | null }>;
    /** Projects whose last deploy failed and that failed at least twice in the window. */
    failingProjects: Array<{ projectId: string; failures: number; lastFailedAt: string; blame: DeployFailureBlame; label: string; error: string | null }>;
  };
  sitesDown: Array<{ projectId: string; downSince: string | null; statusCode: number | null; error: string | null }>;
  servers: Array<{
    serverId: string;
    managed: boolean;
    provider: string;
    status: string;
    setupStatus: string;
    diskUsedPercent: number | null;
    problem: 'error' | 'setup_failed' | 'disk';
    message: string | null;
  }>;
  databases: Array<{ databaseId: string; type: string; status: string; since: string }>;
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return result.rows as T[];
}

const iso = (expr: string) => sql.raw(`to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);

export const opsSignalsService = {
  async getSignals(opts: { since?: Date } = {}): Promise<OpsSignals> {
    const window = sql.raw(`interval '${WINDOW_HOURS} hours'`);
    // A window can only look back as far as the main one.
    const since = opts.since && Date.now() - opts.since.getTime() <= WINDOW_HOURS * 3600_000 ? opts.since : null;

    const sinceRows = since
      ? await rows<{ errorMessage: string | null; status: string }>(sql`
          SELECT error_message AS "errorMessage", status::text AS "status"
            FROM deployments WHERE created_at > ${since.toISOString()}::timestamptz
           LIMIT 2000`)
      : null;

    const [counts, failedRows, failing, down, servers, databases] = await Promise.all([
      rows<{ total: number; failed: number }>(sql`
        SELECT count(*)::int AS "total", count(*) FILTER (WHERE status = 'failed')::int AS "failed"
          FROM deployments WHERE created_at > now() - ${window}`),
      rows<{ errorMessage: string | null; projectId: string | null }>(sql`
        SELECT error_message AS "errorMessage", project_id AS "projectId"
          FROM deployments
         WHERE status = 'failed' AND created_at > now() - ${window}
         ORDER BY created_at DESC LIMIT 500`),
      rows<{ projectId: string; failures: number; lastFailedAt: string; errorMessage: string | null }>(sql`
        WITH recent AS (
          SELECT project_id, status, error_message, created_at,
                 row_number() OVER (PARTITION BY project_id ORDER BY created_at DESC) AS rn
            FROM deployments WHERE created_at > now() - ${window}
        )
        SELECT r.project_id AS "projectId",
               (SELECT count(*) FROM recent f WHERE f.project_id = r.project_id AND f.status = 'failed')::int AS "failures",
               ${iso('r.created_at')} AS "lastFailedAt",
               r.error_message AS "errorMessage"
          FROM recent r
         WHERE r.rn = 1 AND r.status = 'failed'
           AND (SELECT count(*) FROM recent f WHERE f.project_id = r.project_id AND f.status = 'failed') >= 2
         ORDER BY r.created_at DESC LIMIT ${LIST_LIMIT}`),
      rows<{ projectId: string; downSince: string | null; statusCode: number | null; error: string | null }>(sql`
        SELECT project_id AS "projectId", ${iso('down_since')} AS "downSince",
               status_code AS "statusCode", error
          FROM project_health_state
         WHERE status = 'down' AND down_since < now() - ${sql.raw(`interval '${SITE_DOWN_GRACE_MIN} minutes'`)}
         ORDER BY down_since ASC LIMIT ${LIST_LIMIT}`),
      rows<{
        serverId: string; managed: boolean; provider: string; status: string; setupStatus: string;
        diskUsedPercent: number | null; message: string | null;
      }>(sql`
        SELECT id AS "serverId", is_managed AS "managed", provider::text AS "provider",
               status::text AS "status", setup_status::text AS "setupStatus",
               disk_used_percent AS "diskUsedPercent", status_message AS "message"
          FROM servers
         WHERE status <> 'deleting'
           AND (status = 'error'
                OR (setup_status = 'failed' AND updated_at > now() - interval '7 days')
                OR disk_used_percent >= ${DISK_WARN_PERCENT})
         ORDER BY updated_at DESC LIMIT ${LIST_LIMIT}`),
      rows<{ databaseId: string; type: string; status: string; since: string }>(sql`
        SELECT id AS "databaseId", type::text AS "type", status::text AS "status", ${iso('updated_at')} AS "since"
          FROM databases WHERE status = 'error'
         ORDER BY updated_at DESC LIMIT ${LIST_LIMIT}`),
    ]);

    const sinceFailed = sinceRows?.filter((r) => r.status === 'failed') ?? [];
    return {
      generatedAt: new Date().toISOString(),
      windowHours: WINDOW_HOURS,
      since:
        since && sinceRows
          ? {
              since: since.toISOString(),
              total: sinceRows.length,
              failed: sinceFailed.length,
              pushifyFailed: sinceFailed.filter((r) => classifyDeployFailure('', r.errorMessage ?? '').blame === 'pushify').length,
            }
          : null,
      deployments: {
        total: counts[0]?.total ?? 0,
        failed: counts[0]?.failed ?? 0,
        causes: summarizeDeployFailures(failedRows).map((c) => ({
          category: c.category,
          blame: c.blame,
          label: c.label,
          count: c.count,
          projects: c.projects,
          sample: scrubSecrets(c.sample),
        })),
        failingProjects: failing.map((f) => {
          const classified = classifyDeployFailure('', f.errorMessage ?? '');
          return {
            projectId: f.projectId,
            failures: f.failures,
            lastFailedAt: f.lastFailedAt,
            blame: classified.blame,
            label: classified.label,
            error: scrubSecrets(f.errorMessage ? stripFailurePrefix(f.errorMessage) : null),
          };
        }),
      },
      sitesDown: down.map((d) => ({ ...d, error: scrubSecrets(d.error) })),
      servers: servers.map((s) => ({
        ...s,
        problem: s.status === 'error' ? 'error' : s.setupStatus === 'failed' ? 'setup_failed' : 'disk',
        message: scrubSecrets(s.message),
      })),
      databases,
    };
  },
};
