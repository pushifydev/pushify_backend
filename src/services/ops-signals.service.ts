import { sql } from 'drizzle-orm';
import { db } from '../db';
import { classifyDeployFailure, type DeployFailureBlame } from '../lib/deploy-failure-classify';
import { stripFailurePrefix, summarizeDeployFailures } from '../lib/deploy-failure-summary';
import { scrubSecrets } from '../lib/ops-scrub';
import type { ServerDiskBreakdown } from '../lib/server-disk-cleanup';

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
  /**
   * Down sites, with the facts needed to tell a platform fault from a user-side or abandoned
   * project before anyone opens another fix: where it runs, whether that server still reports in,
   * when it last deployed successfully and when an owner last signed in. Timestamps only — no
   * identities. Live DNS is not here: it is not stored, the consumer must resolve it itself.
   */
  sitesDown: SiteDown[];
  servers: Array<{
    serverId: string;
    managed: boolean;
    provider: string;
    status: string;
    setupStatus: string;
    diskUsedPercent: number | null;
    problem: 'error' | 'setup_failed' | 'disk';
    message: string | null;
    /**
     * What holds the disk, from the last scheduled cleanup (managed servers only, null before
     * the first one): sizes in bytes, the largest consumer, whether that is customer data
     * (volumes — out of cleanup scope) and how many containers still have an uncapped log.
     */
    disk: {
      measuredAt: string;
      heldBy: ServerDiskBreakdown['heldBy'];
      userData: boolean;
      usedBytes: number;
      totalBytes: number;
      imagesBytes: number;
      buildCacheBytes: number;
      containersBytes: number;
      logsBytes: number;
      volumesBytes: number;
      uncappedLogContainers: number;
      lastCleanupFreedBytes: number;
    } | null;
  }>;
  databases: Array<{ databaseId: string; type: string; status: string; since: string }>;
}

export interface SiteDown {
  projectId: string;
  downSince: string | null;
  statusCode: number | null;
  error: string | null;
  /** byos: the customer's own server; managed: a server Pushify runs for them; shared: Pushify runner/host. */
  hosting: 'byos' | 'managed' | 'shared';
  serverStatus: string | null;
  serverLastSeenAt: string | null;
  lastSuccessfulDeployAt: string | null;
  ownerLastLoginAt: string | null;
  /** What monitoring concluded: server_unreachable | app_error | deploy_failed (null before the first alert). */
  downReason: string | null;
  /**
   * The project's most recent deployment, classified. A site down behind a failed build whose
   * blame is 'project' is a user-side build failure, not a platform outage; 'pushify' or
   * 'server' blame (or a reachable-server app_error) stays a platform candidate.
   */
  latestDeploy: {
    status: string;
    createdAt: string | null;
    blame: DeployFailureBlame | null;
    label: string | null;
    error: string | null;
  } | null;
}

type SiteDownRow = Omit<SiteDown, 'hosting' | 'latestDeploy'> & {
  managed: boolean | null;
  latestStatus: string | null;
  latestCreatedAt: string | null;
  latestError: string | null;
};

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
      // Only projects monitoring still checks (the same filter as appHealthService.candidates()).
      // A project that left monitoring — paused, asleep, no running deployment, no URL — is never
      // checked again, so its row keeps the last 'down' forever and would stay on this list after
      // the site is fixed. A monitored site that recovers is reset by its next successful check.
      rows<SiteDownRow>(sql`
        SELECT h.project_id AS "projectId", ${iso('h.down_since')} AS "downSince",
               h.status_code AS "statusCode", h.error, h.down_reason AS "downReason",
               ld.status AS "latestStatus", ${iso('ld.created_at')} AS "latestCreatedAt",
               ld.error_message AS "latestError",
               s.is_managed AS "managed", s.status::text AS "serverStatus",
               ${iso('s.last_seen_at')} AS "serverLastSeenAt",
               ${iso(`(SELECT max(d.created_at) FROM deployments d
                        WHERE d.project_id = h.project_id AND d.status IN ('running', 'stopped'))`)} AS "lastSuccessfulDeployAt",
               ${iso(`(SELECT max(e.created_at) FROM auth_events e
                         JOIN organization_members m ON m.user_id = e.user_id
                        WHERE m.organization_id = p.organization_id AND m.role = 'owner'
                          AND e.event IN ('login', 'register'))`)} AS "ownerLastLoginAt"
          FROM project_health_state h
          JOIN projects p ON p.id = h.project_id
          LEFT JOIN servers s ON s.id = p.server_id
          LEFT JOIN LATERAL (SELECT d.status::text AS status, d.created_at, d.error_message
                               FROM deployments d WHERE d.project_id = h.project_id
                              ORDER BY d.created_at DESC LIMIT 1) ld ON true
         WHERE h.status = 'down' AND h.down_since < now() - ${sql.raw(`interval '${SITE_DOWN_GRACE_MIN} minutes'`)}
           AND p.status = 'active' AND p.sleep_state = 'awake'
           AND jsonb_typeof(p.settings -> 'productionUrl') = 'string'
           AND EXISTS (SELECT 1 FROM deployments d WHERE d.project_id = h.project_id AND d.status = 'running')
         ORDER BY h.down_since ASC LIMIT ${LIST_LIMIT}`),
      rows<{
        serverId: string; managed: boolean; provider: string; status: string; setupStatus: string;
        diskUsedPercent: number | null; message: string | null; diskBreakdown: ServerDiskBreakdown | null;
      }>(sql`
        SELECT id AS "serverId", is_managed AS "managed", provider::text AS "provider",
               status::text AS "status", setup_status::text AS "setupStatus",
               disk_used_percent AS "diskUsedPercent", status_message AS "message",
               disk_breakdown AS "diskBreakdown"
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
      sitesDown: down.map(({ managed, latestStatus, latestCreatedAt, latestError, ...d }) => {
        const failed = latestStatus === 'failed';
        const classified = failed ? classifyDeployFailure('', latestError ?? '') : null;
        return {
          ...d,
          hosting: managed === null ? 'shared' : managed ? 'managed' : 'byos',
          error: scrubSecrets(d.error),
          downReason: d.downReason ?? null,
          latestDeploy: latestStatus
            ? {
                status: latestStatus,
                createdAt: latestCreatedAt ?? null,
                blame: classified?.blame ?? null,
                label: classified?.label ?? null,
                error: failed ? scrubSecrets(latestError ? stripFailurePrefix(latestError) : null) : null,
              }
            : null,
        };
      }),
      servers: servers.map(({ diskBreakdown, ...s }) => ({
        ...s,
        problem: s.status === 'error' ? 'error' : s.setupStatus === 'failed' ? 'setup_failed' : 'disk',
        message: scrubSecrets(s.message),
        disk: diskBreakdown
          ? {
              measuredAt: diskBreakdown.measuredAt,
              heldBy: diskBreakdown.heldBy,
              userData: diskBreakdown.userData,
              usedBytes: diskBreakdown.usedBytes,
              totalBytes: diskBreakdown.totalBytes,
              imagesBytes: diskBreakdown.imagesBytes,
              buildCacheBytes: diskBreakdown.buildCacheBytes,
              containersBytes: diskBreakdown.containersBytes,
              logsBytes: diskBreakdown.logsBytes,
              volumesBytes: diskBreakdown.volumesBytes,
              uncappedLogContainers: diskBreakdown.uncappedLogContainers,
              lastCleanupFreedBytes: diskBreakdown.cleanup?.freedBytes ?? 0,
            }
          : null,
      })),
      databases,
    };
  },
};
