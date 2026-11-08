import { sql } from 'drizzle-orm';
import { db } from '../db';
import {
  classifyDeployFailure,
  describeFailureCategory,
  type DeployFailureBlame,
  type DeployFailureCategory,
} from '../lib/deploy-failure-classify';
import {
  countDeployOutcomes,
  isPolicyBlocked,
  NOT_POLICY_BLOCKED_SQL,
  stripFailurePrefix,
  summarizeDeployFailures,
} from '../lib/deploy-failure-summary';
import { FAILURE_SUMMARY_MAX_LENGTH } from '../lib/first-error-line';
import { logger } from '../lib/logger';
import { scrubSecrets } from '../lib/ops-scrub';
import { diagnoseSiteDown, type SiteDownDiagnosis } from '../lib/site-down-diagnosis';
import type { ContainerDownCause } from '../lib/container-down-cause';
import type { ServerDiagnostics } from '../lib/app-health';
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
/** Deploys stopped under the Acceptable Use Policy are not failures (deployments.failure_category). */
const NOT_POLICY_BLOCKED = sql.raw(NOT_POLICY_BLOCKED_SQL);

export interface OpsSignals {
  generatedAt: string;
  windowHours: number;
  /**
   * Deployments started after `since` (when asked): the operations agent's deploy watch compares
   * the minutes after a Pushify release with the day before it.
   */
  since: { since: string; total: number; failed: number; pushifyFailed: number; policyBlocked: number } | null;
  deployments: {
    /** total and failed leave out deploys stopped under the Acceptable Use Policy (policyBlocked). */
    total: number;
    failed: number;
    /** Deploys stopped under the Acceptable Use Policy: not failures, so in neither total nor failed. */
    policyBlocked: number;
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
  /**
   * Down sites diagnosed `user_server_unreachable`: the customer's own server does not answer, or
   * the project's server is powered off / being deleted. Not a platform fault, so they are kept
   * out of sitesDown (which raises the platform alarm) and only listed here for the record.
   */
  userServerUnreachable: SiteDown[];
  /**
   * User side, deploy failed: down sites diagnosed `build_failed`. The latest deployment failed on
   * the project's side and no version of the app runs behind the site (the inspected container is
   * stopped or missing, or the proxy answers with nothing behind it), so nothing will serve until
   * the owner fixes the build and redeploys. Not a platform outage: kept out of sitesDown and only
   * listed here. A site whose server or app is down for any other reason stays in sitesDown.
   */
  userDeployFailed: SiteDown[];
  /**
   * Sites whose last health check said down but whose project was stopped on purpose since:
   * paused by the owner, suspended under the Acceptable Use Policy, asleep (auto-sleep), in
   * maintenance mode or deleted. Never an outage, so never in sitesDown, userServerUnreachable or userDeployFailed;
   * listed with why, so a site that left sitesDown can be told apart from one that was fixed.
   * Most recently down first.
   */
  sitesStopped: Array<{ projectId: string; downSince: string | null; category: SiteStopCategory }>;
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
  /** What monitoring concluded: server_unreachable | app_error | deploy_failed (null before the first alert). See diagnosis.cause for the container's own cause. */
  downReason: string | null;
  /**
   * The project's most recent deployment, classified. A site down behind a failed build whose
   * blame is 'project' is a user-side build failure, not a platform outage; 'pushify' or
   * 'server' blame (or a reachable-server app_error) stays a platform candidate.
   */
  latestDeploy: {
    status: string;
    createdAt: string | null;
    /**
     * Machine-readable failure category (null unless the deploy failed): the one the deploy
     * worker or the backfill stored in deployments.failure_category, else the classifier on the
     * message; 'unknown' when neither names a cause. blame and label are this category's.
     */
    category: DeployFailureCategory | null;
    blame: DeployFailureBlame | null;
    label: string | null;
    error: string | null;
    /** The first error line of the build log (deployments.failure_summary), scrubbed; null when none is stored. */
    firstErrorLine: string | null;
  } | null;
  /**
   * Which layer is down, from the last health check (HTTP status / network error) and the stored
   * server checks rather than from the latest deployment alone, plus whether that is the
   * customer's to fix. Prefer this over downReason, which says deploy_failed whenever the latest
   * deploy failed even when the site gives no HTTP answer at all. kind 'unknown' when the stored
   * record cannot be diagnosed.
   */
  diagnosis: SiteDownDiagnosis & { container: SiteDownContainer };
}

/**
 * What the inspected app container showed (project_health_state.diagnostics.container): its
 * Docker state, exit code, restarts, OOM flag and ports. Never its name (it carries the project
 * slug), its log lines or its hint. state 'unknown': it could not be inspected, or no inspection
 * is stored for this outage.
 */
export interface SiteDownContainer {
  state: string;
  cause: ContainerDownCause | null;
  checkedAt: string | null;
  exitCode: number | null;
  restartCount: number | null;
  oomKilled: boolean | null;
  configuredPort: number | null;
  listeningPorts: number[] | null;
  loopbackPorts: number[] | null;
}

/** Why a project is not served on purpose, so a 'down' stored for it is not an outage. */
export type SiteStopCategory = 'policy_suspended' | 'deleted' | 'stopped_by_user' | 'sleeping' | 'maintenance';

/** The project's own state, read only to tell a stopped project from a down site; never passed through. */
interface ProjectStateColumns {
  projectStatus?: string | null;
  sleepState?: string | null;
  suspended?: boolean | null;
  maintenance?: boolean | null;
}

const PROJECT_STATE_COLUMNS = sql.raw(
  `p.status::text AS "projectStatus", p.sleep_state AS "sleepState",
   (p.suspended_at IS NOT NULL) AS "suspended",
   coalesce((p.maintenance_mode ->> 'enabled') = 'true', false) AS "maintenance"`
);

/**
 * Why the project is stopped on purpose, or null when it should be serving. A suspension (the
 * project is also paused) comes first, then deletion, the owner's pause, auto-sleep (asleep or
 * waking) and maintenance mode, whose 503 page says nothing about the app behind it.
 */
export function projectStopCategory(p: ProjectStateColumns): SiteStopCategory | null {
  if (p.suspended) return 'policy_suspended';
  if (p.projectStatus === 'deleted') return 'deleted';
  if (p.projectStatus === 'paused') return 'stopped_by_user';
  if (p.sleepState && p.sleepState !== 'awake') return 'sleeping';
  if (p.maintenance) return 'maintenance';
  return null;
}

type SiteDownRow = Omit<SiteDown, 'hosting' | 'latestDeploy' | 'diagnosis'> & ProjectStateColumns & {
  managed: boolean | null;
  /** Read only to name a known stop reason in the diagnosis; never passed through. */
  serverStatusMessage?: string | null;
  diagnostics?: ServerDiagnostics | null;
  latestStatus: string | null;
  latestCreatedAt: string | null;
  latestError: string | null;
  latestFailureCategory?: string | null;
  latestFailureSummary?: string | null;
};

/**
 * The latest deploy's failure: the category stored with it when that names a cause, else the
 * classifier on the message, as before (rows stored before migration 0078, or as 'unknown').
 */
function latestFailure(storedCategory: string | null | undefined, errorMessage: string | null) {
  const stored = storedCategory ? describeFailureCategory(storedCategory) : null;
  if (stored && stored.category !== 'unknown') return stored;
  const { category, blame, label } = classifyDeployFailure('', errorMessage ?? '');
  return { category, blame, label };
}

const CONTAINER_STATE = /^[a-z_]{1,32}$/;
const intOrNull = (v: unknown) => (Number.isInteger(v) ? (v as number) : null);
const portsOrNull = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is number => Number.isInteger(p)) : null);

/** The stored container inspection, field by field: the jsonb may be from an older shape, or absent. */
function containerFacts(diagnostics: ServerDiagnostics | null | undefined): SiteDownContainer {
  const c = (diagnostics?.container ?? null) as Record<string, unknown> | null;
  if (!c || typeof c !== 'object') {
    return { state: 'unknown', cause: null, checkedAt: null, exitCode: null, restartCount: null, oomKilled: null, configuredPort: null, listeningPorts: null, loopbackPorts: null };
  }
  return {
    state: typeof c.state === 'string' && CONTAINER_STATE.test(c.state) ? c.state : 'unknown',
    cause: typeof c.cause === 'string' && CONTAINER_STATE.test(c.cause) ? (c.cause as ContainerDownCause) : null,
    checkedAt: typeof c.checkedAt === 'string' ? c.checkedAt : null,
    exitCode: intOrNull(c.exitCode),
    restartCount: intOrNull(c.restartCount),
    oomKilled: typeof c.oomKilled === 'boolean' ? c.oomKilled : null,
    configuredPort: intOrNull(c.configuredPort),
    listeningPorts: portsOrNull(c.listeningPorts),
    loopbackPorts: portsOrNull(c.loopbackPorts),
  };
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
      ? await rows<{ errorMessage: string | null; status: string; failureCategory: string | null }>(sql`
          SELECT error_message AS "errorMessage", status::text AS "status", failure_category AS "failureCategory"
            FROM deployments WHERE created_at > ${since.toISOString()}::timestamptz
           LIMIT 2000`)
      : null;

    const [outcomes, failedRows, failing, down, stopped, servers, databases] = await Promise.all([
      rows<{ status: string; failureCategory: string | null; count: number }>(sql`
        SELECT status::text AS "status", failure_category AS "failureCategory", count(*)::int AS "count"
          FROM deployments WHERE created_at > now() - ${window}
         GROUP BY 1, 2`),
      rows<{ errorMessage: string | null; projectId: string | null }>(sql`
        SELECT error_message AS "errorMessage", project_id AS "projectId"
          FROM deployments
         WHERE status = 'failed' AND ${NOT_POLICY_BLOCKED} AND created_at > now() - ${window}
         ORDER BY created_at DESC LIMIT 500`),
      rows<{ projectId: string; failures: number; lastFailedAt: string; errorMessage: string | null }>(sql`
        WITH recent AS (
          SELECT project_id, status, error_message, created_at,
                 row_number() OVER (PARTITION BY project_id ORDER BY created_at DESC) AS rn
            FROM deployments WHERE created_at > now() - ${window} AND ${NOT_POLICY_BLOCKED}
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
      // A project in maintenance mode is still checked, but its 503 page says nothing about the
      // app, so it is left out too. All of these are listed in sitesStopped instead.
      rows<SiteDownRow>(sql`
        SELECT h.project_id AS "projectId", ${iso('h.down_since')} AS "downSince",
               h.status_code AS "statusCode", h.error, h.down_reason AS "downReason",
               h.diagnostics AS "diagnostics", ${PROJECT_STATE_COLUMNS},
               ld.status AS "latestStatus", ${iso('ld.created_at')} AS "latestCreatedAt",
               ld.error_message AS "latestError", ld.failure_category AS "latestFailureCategory",
               ld.failure_summary AS "latestFailureSummary",
               s.is_managed AS "managed", s.status::text AS "serverStatus",
               s.status_message AS "serverStatusMessage",
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
          LEFT JOIN LATERAL (SELECT d.status::text AS status, d.created_at, d.error_message,
                                    d.failure_category, d.failure_summary
                               FROM deployments d WHERE d.project_id = h.project_id
                              ORDER BY d.created_at DESC LIMIT 1) ld ON true
         WHERE h.status = 'down' AND h.down_since < now() - ${sql.raw(`interval '${SITE_DOWN_GRACE_MIN} minutes'`)}
           AND p.status = 'active' AND p.sleep_state = 'awake' AND p.suspended_at IS NULL
           AND (p.maintenance_mode ->> 'enabled') IS DISTINCT FROM 'true'
           AND jsonb_typeof(p.settings -> 'productionUrl') = 'string'
           AND EXISTS (SELECT 1 FROM deployments d WHERE d.project_id = h.project_id AND d.status = 'running')
         ORDER BY h.down_since ASC LIMIT ${LIST_LIMIT}`),
      // The 'down' rows the filter above leaves out because the project was stopped on purpose.
      rows<{ projectId: string; downSince: string | null } & ProjectStateColumns>(sql`
        SELECT h.project_id AS "projectId", ${iso('h.down_since')} AS "downSince", ${PROJECT_STATE_COLUMNS}
          FROM project_health_state h
          JOIN projects p ON p.id = h.project_id
         WHERE h.status = 'down'
           AND (p.status <> 'active' OR p.sleep_state <> 'awake' OR p.suspended_at IS NOT NULL
                OR (p.maintenance_mode ->> 'enabled') = 'true')
         ORDER BY h.down_since DESC NULLS LAST LIMIT ${LIST_LIMIT}`),
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

    const counts = countDeployOutcomes(outcomes);
    const sinceCounts = sinceRows ? countDeployOutcomes(sinceRows) : null;
    const sinceFailed = sinceRows?.filter((r) => r.status === 'failed' && !isPolicyBlocked(r)) ?? [];
    // The query already leaves projects stopped on purpose out; the same rule as sitesStopped
    // keeps one of them from ever raising the down-site alarm.
    const monitored = down.filter((row) => projectStopCategory(row) === null);
    const sitesStopped = stopped.flatMap((row) => {
      const category = projectStopCategory(row);
      return category ? [{ projectId: row.projectId, downSince: row.downSince ?? null, category }] : [];
    });
    const diagnosed: SiteDown[] = monitored.map(({ managed, latestStatus, latestCreatedAt, latestError, latestFailureCategory, latestFailureSummary, diagnostics, serverStatusMessage, projectStatus: _status, sleepState: _sleep, suspended: _suspended, maintenance: _maintenance, ...d }) => {
      const failed = latestStatus === 'failed';
      const classified = failed ? latestFailure(latestFailureCategory, latestError) : null;
      const hosting: SiteDown['hosting'] = managed === null || managed === undefined ? 'shared' : managed ? 'managed' : 'byos';
      let diagnosis: SiteDownDiagnosis;
      try {
        diagnosis = diagnoseSiteDown({
          statusCode: d.statusCode ?? null,
          error: d.error ?? null,
          hosting,
          diagnostics: diagnostics ?? null,
          latestDeploy: latestStatus ? { status: latestStatus, blame: classified?.blame ?? null, label: classified?.label ?? null } : null,
          serverStatus: d.serverStatus ?? null,
          serverStatusMessage: serverStatusMessage ?? null,
        });
      } catch (err) {
        // A stored record in a shape the diagnosis cannot read must not take the whole endpoint down.
        logger.warn({ err, projectId: d.projectId }, 'Could not diagnose a down site for ops signals');
        diagnosis = { kind: 'unknown', userSide: null, summary: 'The stored health record could not be diagnosed.' };
      }
      return {
        ...d,
        hosting,
        error: scrubSecrets(d.error),
        downReason: d.downReason ?? null,
        latestDeploy: latestStatus
          ? {
              status: latestStatus,
              createdAt: latestCreatedAt ?? null,
              category: classified?.category ?? null,
              blame: classified?.blame ?? null,
              label: classified?.label ?? null,
              error: failed ? scrubSecrets(latestError ? stripFailurePrefix(latestError) : null) : null,
              firstErrorLine: failed ? scrubSecrets(latestFailureSummary, FAILURE_SUMMARY_MAX_LENGTH) : null,
            }
          : null,
        diagnosis: { ...diagnosis, summary: scrubSecrets(diagnosis.summary) ?? diagnosis.summary, container: containerFacts(diagnostics) },
      };
    });
    const userServer = (s: SiteDown) => s.diagnosis.kind === 'user_server_unreachable';
    // build_failed is only diagnosed when the latest deploy failed on the project's side and no app
    // runs behind the site; a Pushify- or server-side failure, or an app that runs, stays in sitesDown.
    const userDeploy = (s: SiteDown) => s.diagnosis.kind === 'build_failed' && s.diagnosis.userSide === true;
    return {
      generatedAt: new Date().toISOString(),
      windowHours: WINDOW_HOURS,
      since:
        since && sinceCounts
          ? {
              since: since.toISOString(),
              total: sinceCounts.total,
              failed: sinceCounts.failed,
              pushifyFailed: sinceFailed.filter((r) => classifyDeployFailure('', r.errorMessage ?? '').blame === 'pushify').length,
              policyBlocked: sinceCounts.policyBlocked,
            }
          : null,
      deployments: {
        total: counts.total,
        failed: counts.failed,
        policyBlocked: counts.policyBlocked,
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
      sitesDown: diagnosed.filter((s) => !userServer(s) && !userDeploy(s)),
      userServerUnreachable: diagnosed.filter(userServer),
      userDeployFailed: diagnosed.filter(userDeploy),
      sitesStopped,
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
