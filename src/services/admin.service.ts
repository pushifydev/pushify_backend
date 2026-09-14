import { sql, eq, desc } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema/users';
import { authEvents, adminAuditLogs, type AuthEventType, type AuthMethod } from '../db/schema/auth-events';
import { userRepository } from '../repositories/user.repository';
import { logger } from '../lib/logger';
import { normalizeClientIp } from '../lib/utils';

/**
 * Read-only, platform-wide views for the operator panel. Everything here crosses organisation
 * boundaries on purpose — the caller has already passed requirePlatformAdmin. Nothing in this
 * file writes to customer data; the only write is the admin audit row.
 *
 * Every timestamp leaves this module as an ISO-8601 UTC string. The raw-SQL path hands
 * timestamps back as Postgres text (`2026-09-14 16:22:30.52+03`), which not every Date parser
 * accepts, so the queries format them with `iso()` and the query-builder results are converted
 * with `toISOString()` — one shape at the API boundary either way.
 */

// ============ Types ============

export interface AdminOverview {
  users: { total: number; verified: number; withTwoFactor: number; last7d: number; last30d: number };
  funnel: {
    registered: number;
    verified: number;
    createdProject: number;
    deployed: number;
    deploySucceeded: number;
    connectedServer: number;
    createdDatabase: number;
    paid: number;
  };
  active: { logins7d: number; logins30d: number; activeUsers7d: number; activeUsers30d: number };
  byDay: { day: string; signups: number; logins: number }[];
  deployments: { total: number; last7d: number; failed7d: number; byStatus: { status: string; count: number }[] };
  resources: {
    projects: number;
    activeProjects: number;
    servers: number;
    databases: number;
    organizations: number;
    paidOrganizations: number;
  };
  plans: { plan: string; count: number }[];
}

export type SignupMethod = 'password' | 'github' | 'google';
export type AdminUserSort = 'newest' | 'last_seen' | 'most_active';

export interface AdminUserListQuery {
  search: string;
  sort: AdminUserSort;
  limit: number;
  offset: number;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  createdAt: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  signupMethod: SignupMethod;
  plan: string | null;
  organizations: number;
  projects: number;
  deployments: number;
  failedDeployments: number;
  servers: number;
  databases: number;
  activityCount: number;
  lastLoginAt: string | null;
  lastActivityAt: string | null;
  lastSeenAt: string | null;
}

export interface AdminUserOrganization {
  id: string;
  name: string;
  slug: string;
  plan: string;
  billingStatus: string;
  infraWalletBalanceCents: number;
  role: string;
  joinedAt: string;
  createdAt: string;
  memberCount: number;
  projectCount: number;
}

export interface AdminUserProject {
  id: string;
  name: string;
  slug: string;
  status: string;
  gitProvider: string | null;
  gitRepoUrl: string | null;
  organizationId: string;
  createdAt: string;
  deploymentCount: number;
  lastDeploymentStatus: string | null;
  lastDeploymentAt: string | null;
}

export interface AdminUserDeployment {
  id: string;
  projectId: string;
  projectName: string;
  status: string;
  trigger: string;
  branch: string | null;
  commitMessage: string | null;
  errorMessage: string | null;
  triggeredById: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AdminUserServer {
  id: string;
  name: string;
  provider: string;
  status: string;
  setupStatus: string;
  region: string;
  size: string;
  isManaged: boolean;
  ipv4: string | null;
  createdAt: string;
}

export interface AdminUserDatabase {
  id: string;
  name: string;
  type: string;
  status: string;
  createdAt: string;
}

export interface AdminUserSession {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface AdminAuthEvent {
  id: string;
  event: AuthEventType;
  method: AuthMethod;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface AdminUserActivity {
  id: string;
  action: string;
  description: string;
  metadata: Record<string, unknown>;
  projectId: string | null;
  projectName: string | null;
  ipAddress: string | null;
  createdAt: string;
}

export type AdminTimelineEntry =
  | { at: string; kind: 'auth'; event: AuthEventType; method: AuthMethod; ipAddress: string | null; userAgent: string | null }
  | { at: string; kind: 'activity'; action: string; description: string; projectName: string | null }
  | { at: string; kind: 'project'; id: string; name: string; gitProvider: string | null }
  | { at: string; kind: 'deployment'; id: string; projectName: string; status: string; trigger: string; errorMessage: string | null }
  | { at: string; kind: 'server'; id: string; name: string; provider: string; isManaged: boolean }
  | { at: string; kind: 'database'; id: string; name: string; type: string };

export interface AdminUserDetail {
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    createdAt: string;
    updatedAt: string;
    emailVerified: boolean;
    emailVerifiedAt: string | null;
    twoFactorEnabled: boolean;
    hasPassword: boolean;
    githubLinked: boolean;
    googleLinked: boolean;
    signupMethod: SignupMethod;
  };
  organizations: AdminUserOrganization[];
  projects: AdminUserProject[];
  deployments: AdminUserDeployment[];
  servers: AdminUserServer[];
  databases: AdminUserDatabase[];
  sessions: AdminUserSession[];
  authEvents: AdminAuthEvent[];
  activity: AdminUserActivity[];
  timeline: AdminTimelineEntry[];
}

export interface AdminActivityItem {
  id: string;
  action: string;
  description: string;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
  user: { id: string; email: string; name: string } | null;
  organization: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
}

export interface AdminAuthEventItem extends AdminAuthEvent {
  user: { id: string; email: string; name: string } | null;
}

export interface PageQuery {
  limit: number;
  offset: number;
}

// ============ Helpers ============

// The row shape is asserted, not inferred — every query below aliases its columns to match
// the interface it is read into.
async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return result.rows as T[];
}

async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  const [row] = await rows<T>(query);
  return row;
}

/** Format a timestamptz column/expression as an ISO-8601 UTC string (NULL stays NULL). */
const iso = (expr: string) =>
  sql.raw(`to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

const toIso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Organisations the user belongs to — the scope every per-user resource query is limited to. */
const userOrgs = (userId: string) =>
  sql`(SELECT organization_id FROM organization_members WHERE user_id = ${userId})`;

const signupMethodSql = (alias: string) =>
  sql.raw(
    `CASE WHEN ${alias}.github_id IS NOT NULL THEN 'github' WHEN ${alias}.google_id IS NOT NULL THEN 'google' ELSE 'password' END`,
  );

// ORDER BY works on the aggregate CTE's raw columns, before aliasing/formatting.
const USER_SORT: Record<AdminUserSort, string> = {
  newest: 'created_at DESC',
  last_seen: 'GREATEST(last_login_at, last_activity_at, last_session_at) DESC NULLS LAST, created_at DESC',
  most_active: 'deployments DESC, activity_count DESC, created_at DESC',
};

// ============ Service ============

export const adminService = {
  async getOverview(): Promise<AdminOverview> {
    const [usersRow, funnel, active, byDay, deployRow, byStatus, resources, plans] = await Promise.all([
      one<AdminOverview['users']>(sql`
        SELECT count(*)::int AS "total",
               count(*) FILTER (WHERE email_verified)::int AS "verified",
               count(*) FILTER (WHERE two_factor_enabled)::int AS "withTwoFactor",
               count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS "last7d",
               count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS "last30d"
        FROM users`),
      one<AdminOverview['funnel']>(sql`
        WITH uo AS (SELECT DISTINCT user_id, organization_id FROM organization_members)
        SELECT
          (SELECT count(*) FROM users)::int AS "registered",
          (SELECT count(*) FROM users WHERE email_verified)::int AS "verified",
          (SELECT count(DISTINCT uo.user_id) FROM uo
             JOIN projects p ON p.organization_id = uo.organization_id)::int AS "createdProject",
          (SELECT count(DISTINCT uo.user_id) FROM uo
             JOIN projects p ON p.organization_id = uo.organization_id
             JOIN deployments d ON d.project_id = p.id)::int AS "deployed",
          (SELECT count(DISTINCT uo.user_id) FROM uo
             JOIN projects p ON p.organization_id = uo.organization_id
             JOIN deployments d ON d.project_id = p.id
            WHERE d.status IN ('running', 'stopped'))::int AS "deploySucceeded",
          (SELECT count(DISTINCT uo.user_id) FROM uo
             JOIN servers s ON s.organization_id = uo.organization_id)::int AS "connectedServer",
          (SELECT count(DISTINCT uo.user_id) FROM uo
             JOIN databases x ON x.organization_id = uo.organization_id)::int AS "createdDatabase",
          (SELECT count(DISTINCT uo.user_id) FROM uo
             JOIN organizations o ON o.id = uo.organization_id
            WHERE o.plan <> 'free')::int AS "paid"`),
      one<AdminOverview['active']>(sql`
        SELECT
          (SELECT count(*) FROM auth_events
            WHERE event = 'login' AND created_at > now() - interval '7 days')::int AS "logins7d",
          (SELECT count(*) FROM auth_events
            WHERE event = 'login' AND created_at > now() - interval '30 days')::int AS "logins30d",
          (SELECT count(DISTINCT user_id) FROM (
              SELECT user_id FROM auth_events
               WHERE event IN ('login', 'register') AND created_at > now() - interval '7 days'
              UNION
              SELECT user_id FROM activity_logs WHERE created_at > now() - interval '7 days'
            ) x WHERE user_id IS NOT NULL)::int AS "activeUsers7d",
          (SELECT count(DISTINCT user_id) FROM (
              SELECT user_id FROM auth_events
               WHERE event IN ('login', 'register') AND created_at > now() - interval '30 days'
              UNION
              SELECT user_id FROM activity_logs WHERE created_at > now() - interval '30 days'
            ) x WHERE user_id IS NOT NULL)::int AS "activeUsers30d"`),
      rows<AdminOverview['byDay'][number]>(sql`
        SELECT to_char(d, 'YYYY-MM-DD') AS "day",
               (SELECT count(*) FROM users u
                 WHERE u.created_at >= d AND u.created_at < d + interval '1 day')::int AS "signups",
               (SELECT count(*) FROM auth_events e
                 WHERE e.event = 'login' AND e.created_at >= d AND e.created_at < d + interval '1 day')::int AS "logins"
        FROM generate_series(
               date_trunc('day', now()) - interval '29 days',
               date_trunc('day', now()),
               interval '1 day') AS d
        ORDER BY d`),
      one<{ total: number; last7d: number; failed7d: number }>(sql`
        SELECT count(*)::int AS "total",
               count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS "last7d",
               count(*) FILTER (WHERE created_at > now() - interval '7 days' AND status = 'failed')::int AS "failed7d"
        FROM deployments`),
      rows<{ status: string; count: number }>(sql`
        SELECT status::text AS "status", count(*)::int AS "count"
        FROM deployments GROUP BY 1 ORDER BY 2 DESC`),
      one<AdminOverview['resources']>(sql`
        SELECT
          (SELECT count(*) FROM projects WHERE status <> 'deleted')::int AS "projects",
          (SELECT count(*) FROM projects WHERE status = 'active')::int AS "activeProjects",
          (SELECT count(*) FROM servers)::int AS "servers",
          (SELECT count(*) FROM databases)::int AS "databases",
          (SELECT count(*) FROM organizations)::int AS "organizations",
          (SELECT count(*) FROM organizations WHERE plan <> 'free')::int AS "paidOrganizations"`),
      rows<{ plan: string; count: number }>(sql`
        SELECT plan::text AS "plan", count(*)::int AS "count"
        FROM organizations GROUP BY 1 ORDER BY 2 DESC`),
    ]);

    return {
      users: usersRow,
      funnel,
      active,
      byDay,
      deployments: { ...deployRow, byStatus },
      resources,
      plans,
    };
  },

  async listUsers(query: AdminUserListQuery): Promise<{ users: AdminUserSummary[]; total: number }> {
    const search = query.search.trim();
    const pattern = `%${search.replace(/[%_\\]/g, '\\$&')}%`;

    const result = await rows<AdminUserSummary & { total: number }>(sql`
      WITH base AS (
        SELECT u.id, u.email, u.name, u.avatar_url, u.created_at, u.email_verified,
               u.two_factor_enabled, u.github_id, u.google_id
        FROM users u
        WHERE ${search} = '' OR u.email ILIKE ${pattern} OR u.name ILIKE ${pattern}
      ),
      agg AS (
        SELECT b.*,
               (SELECT max(o.plan)::text FROM organization_members m
                  JOIN organizations o ON o.id = m.organization_id
                 WHERE m.user_id = b.id) AS plan,
               (SELECT count(*) FROM organization_members m WHERE m.user_id = b.id)::int AS organizations,
               (SELECT count(*) FROM projects p
                  JOIN organization_members m ON m.organization_id = p.organization_id AND m.user_id = b.id)::int AS projects,
               (SELECT count(*) FROM deployments d
                  JOIN projects p ON p.id = d.project_id
                  JOIN organization_members m ON m.organization_id = p.organization_id AND m.user_id = b.id)::int AS deployments,
               (SELECT count(*) FROM deployments d
                  JOIN projects p ON p.id = d.project_id
                  JOIN organization_members m ON m.organization_id = p.organization_id AND m.user_id = b.id
                 WHERE d.status = 'failed')::int AS failed_deployments,
               (SELECT count(*) FROM servers s
                  JOIN organization_members m ON m.organization_id = s.organization_id AND m.user_id = b.id)::int AS servers,
               (SELECT count(*) FROM databases x
                  JOIN organization_members m ON m.organization_id = x.organization_id AND m.user_id = b.id)::int AS databases,
               (SELECT count(*) FROM activity_logs a WHERE a.user_id = b.id)::int AS activity_count,
               (SELECT max(e.created_at) FROM auth_events e
                 WHERE e.user_id = b.id AND e.event IN ('login', 'register')) AS last_login_at,
               (SELECT max(a.created_at) FROM activity_logs a WHERE a.user_id = b.id) AS last_activity_at,
               (SELECT max(s.created_at) FROM user_sessions s WHERE s.user_id = b.id) AS last_session_at
        FROM base b
      )
      SELECT id, email, name,
             avatar_url AS "avatarUrl",
             ${iso('created_at')} AS "createdAt",
             email_verified AS "emailVerified",
             two_factor_enabled AS "twoFactorEnabled",
             ${signupMethodSql('agg')} AS "signupMethod",
             plan, organizations, projects, deployments,
             failed_deployments AS "failedDeployments",
             servers, databases,
             activity_count AS "activityCount",
             ${iso('last_login_at')} AS "lastLoginAt",
             ${iso('last_activity_at')} AS "lastActivityAt",
             ${iso('GREATEST(last_login_at, last_activity_at, last_session_at)')} AS "lastSeenAt",
             count(*) OVER()::int AS "total"
      FROM agg
      ORDER BY ${sql.raw(USER_SORT[query.sort])}
      LIMIT ${query.limit} OFFSET ${query.offset}`);

    const total = result[0]?.total ?? 0;
    return {
      users: result.map(({ total: _total, ...user }) => user),
      total,
    };
  },

  async getUserDetail(userId: string): Promise<AdminUserDetail | null> {
    const full = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        createdAt: true,
        updatedAt: true,
        emailVerified: true,
        emailVerifiedAt: true,
        twoFactorEnabled: true,
        passwordHash: true,
        githubId: true,
        googleId: true,
      },
    });
    if (!full) return null;

    const orgs = userOrgs(userId);
    const [organizations, projects, deployments, servers, databases, sessionRows, eventRows, activity] =
      await Promise.all([
        rows<AdminUserOrganization>(sql`
          SELECT o.id, o.name, o.slug,
                 o.plan::text AS "plan",
                 o.billing_status::text AS "billingStatus",
                 o.infra_wallet_balance_cents AS "infraWalletBalanceCents",
                 m.role::text AS "role",
                 ${iso('m.joined_at')} AS "joinedAt",
                 ${iso('o.created_at')} AS "createdAt",
                 (SELECT count(*) FROM organization_members x WHERE x.organization_id = o.id)::int AS "memberCount",
                 (SELECT count(*) FROM projects p WHERE p.organization_id = o.id)::int AS "projectCount"
          FROM organization_members m
          JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = ${userId}
          ORDER BY m.joined_at`),
        rows<AdminUserProject>(sql`
          SELECT p.id, p.name, p.slug,
                 p.status::text AS "status",
                 p.git_provider AS "gitProvider",
                 p.git_repo_url AS "gitRepoUrl",
                 p.organization_id AS "organizationId",
                 ${iso('p.created_at')} AS "createdAt",
                 (SELECT count(*) FROM deployments d WHERE d.project_id = p.id)::int AS "deploymentCount",
                 (SELECT d.status::text FROM deployments d WHERE d.project_id = p.id
                   ORDER BY d.created_at DESC LIMIT 1) AS "lastDeploymentStatus",
                 ${iso('SELECT d.created_at FROM deployments d WHERE d.project_id = p.id ORDER BY d.created_at DESC LIMIT 1')} AS "lastDeploymentAt"
          FROM projects p
          WHERE p.organization_id IN ${orgs}
          ORDER BY p.created_at DESC`),
        rows<AdminUserDeployment>(sql`
          SELECT d.id,
                 d.project_id AS "projectId",
                 p.name AS "projectName",
                 d.status::text AS "status",
                 d.trigger::text AS "trigger",
                 d.branch,
                 left(d.commit_message, 140) AS "commitMessage",
                 left(d.error_message, 300) AS "errorMessage",
                 d.triggered_by_id AS "triggeredById",
                 ${iso('d.created_at')} AS "createdAt",
                 ${iso('coalesce(d.deploy_finished_at, d.build_finished_at)')} AS "finishedAt"
          FROM deployments d
          JOIN projects p ON p.id = d.project_id
          WHERE p.organization_id IN ${orgs}
          ORDER BY d.created_at DESC
          LIMIT 100`),
        rows<AdminUserServer>(sql`
          SELECT id, name,
                 provider::text AS "provider",
                 status::text AS "status",
                 setup_status::text AS "setupStatus",
                 region,
                 size::text AS "size",
                 is_managed AS "isManaged",
                 ipv4,
                 ${iso('created_at')} AS "createdAt"
          FROM servers
          WHERE organization_id IN ${orgs}
          ORDER BY created_at DESC`),
        rows<AdminUserDatabase>(sql`
          SELECT id, name,
                 type::text AS "type",
                 status::text AS "status",
                 ${iso('created_at')} AS "createdAt"
          FROM databases
          WHERE organization_id IN ${orgs}
          ORDER BY created_at DESC`),
        userRepository.findAllSessionsByUserId(userId),
        db
          .select({
            id: authEvents.id,
            event: authEvents.event,
            method: authEvents.method,
            ipAddress: authEvents.ipAddress,
            userAgent: authEvents.userAgent,
            createdAt: authEvents.createdAt,
          })
          .from(authEvents)
          .where(eq(authEvents.userId, userId))
          .orderBy(desc(authEvents.createdAt))
          .limit(100),
        rows<AdminUserActivity>(sql`
          SELECT a.id,
                 a.action::text AS "action",
                 a.description,
                 a.metadata,
                 a.project_id AS "projectId",
                 p.name AS "projectName",
                 a.ip_address AS "ipAddress",
                 ${iso('a.created_at')} AS "createdAt"
          FROM activity_logs a
          LEFT JOIN projects p ON p.id = a.project_id
          WHERE a.user_id = ${userId}
          ORDER BY a.created_at DESC
          LIMIT 100`),
      ]);

    const sessions: AdminUserSession[] = sessionRows.map((s) => ({
      id: s.id,
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
    }));
    const events: AdminAuthEvent[] = eventRows.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() }));

    const timeline: AdminTimelineEntry[] = [
      ...events.map((e): AdminTimelineEntry => ({
        at: e.createdAt, kind: 'auth', event: e.event, method: e.method,
        ipAddress: e.ipAddress, userAgent: e.userAgent,
      })),
      // Project creation and deployments come from their own tables below — skip the log rows
      // that would say the same thing twice.
      ...activity
        .filter((a) => a.action !== 'project.created' && !a.action.startsWith('deployment.'))
        .map((a): AdminTimelineEntry => ({
          at: a.createdAt, kind: 'activity', action: a.action, description: a.description,
          projectName: a.projectName,
        })),
      ...projects.map((p): AdminTimelineEntry => ({
        at: p.createdAt, kind: 'project', id: p.id, name: p.name, gitProvider: p.gitProvider,
      })),
      ...deployments.map((d): AdminTimelineEntry => ({
        at: d.createdAt, kind: 'deployment', id: d.id, projectName: d.projectName,
        status: d.status, trigger: d.trigger, errorMessage: d.errorMessage,
      })),
      ...servers.map((s): AdminTimelineEntry => ({
        at: s.createdAt, kind: 'server', id: s.id, name: s.name, provider: s.provider, isManaged: s.isManaged,
      })),
      ...databases.map((x): AdminTimelineEntry => ({
        at: x.createdAt, kind: 'database', id: x.id, name: x.name, type: x.type,
      })),
    ]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, 300);

    return {
      user: {
        id: full.id,
        email: full.email,
        name: full.name,
        avatarUrl: full.avatarUrl,
        createdAt: full.createdAt.toISOString(),
        updatedAt: full.updatedAt.toISOString(),
        emailVerified: full.emailVerified,
        emailVerifiedAt: toIso(full.emailVerifiedAt),
        twoFactorEnabled: full.twoFactorEnabled,
        hasPassword: !!full.passwordHash,
        githubLinked: !!full.githubId,
        googleLinked: !!full.googleId,
        signupMethod: full.githubId ? 'github' : full.googleId ? 'google' : 'password',
      },
      organizations,
      projects,
      deployments,
      servers,
      databases,
      sessions,
      authEvents: events,
      activity,
      timeline,
    };
  },

  async listActivity(query: PageQuery): Promise<{ items: AdminActivityItem[]; total: number }> {
    type Row = {
      id: string; action: string; description: string; metadata: Record<string, unknown>;
      ipAddress: string | null; createdAt: string;
      userId: string | null; userEmail: string | null; userName: string | null;
      organizationId: string | null; organizationName: string | null;
      projectId: string | null; projectName: string | null;
      total: number;
    };
    const result = await rows<Row>(sql`
      SELECT a.id, a.action::text AS "action", a.description, a.metadata,
             a.ip_address AS "ipAddress",
             ${iso('a.created_at')} AS "createdAt",
             u.id AS "userId", u.email AS "userEmail", u.name AS "userName",
             o.id AS "organizationId", o.name AS "organizationName",
             p.id AS "projectId", p.name AS "projectName",
             count(*) OVER()::int AS "total"
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN organizations o ON o.id = a.organization_id
      LEFT JOIN projects p ON p.id = a.project_id
      ORDER BY a.created_at DESC
      LIMIT ${query.limit} OFFSET ${query.offset}`);

    return {
      total: result[0]?.total ?? 0,
      items: result.map((r) => ({
        id: r.id, action: r.action, description: r.description, metadata: r.metadata,
        ipAddress: r.ipAddress, createdAt: r.createdAt,
        user: r.userId ? { id: r.userId, email: r.userEmail!, name: r.userName! } : null,
        organization: r.organizationId ? { id: r.organizationId, name: r.organizationName! } : null,
        project: r.projectId ? { id: r.projectId, name: r.projectName! } : null,
      })),
    };
  },

  async listAuthEvents(query: PageQuery): Promise<{ items: AdminAuthEventItem[]; total: number }> {
    type Row = AdminAuthEvent & {
      userId: string | null; userEmail: string | null; userName: string | null; total: number;
    };
    const result = await rows<Row>(sql`
      SELECT e.id, e.event, e.method,
             e.ip_address AS "ipAddress",
             e.user_agent AS "userAgent",
             ${iso('e.created_at')} AS "createdAt",
             u.id AS "userId", u.email AS "userEmail", u.name AS "userName",
             count(*) OVER()::int AS "total"
      FROM auth_events e
      LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.created_at DESC
      LIMIT ${query.limit} OFFSET ${query.offset}`);

    return {
      total: result[0]?.total ?? 0,
      items: result.map(({ userId, userEmail, userName, total: _total, ...e }) => ({
        ...e,
        user: userId ? { id: userId, email: userEmail!, name: userName! } : null,
      })),
    };
  },
};

// ============ Audit ============

export interface AdminAccessInput {
  adminUserId: string;
  method: string;
  path: string;
  ipAddress?: string;
  userAgent?: string;
}

/** Fire-and-forget; an audit write failure is logged, never surfaced to the request. */
export function recordAdminAccess(input: AdminAccessInput): void {
  db.insert(adminAuditLogs)
    .values({
      adminUserId: input.adminUserId,
      method: input.method.slice(0, 8),
      path: input.path.slice(0, 500),
      ipAddress: normalizeClientIp(input.ipAddress),
      userAgent: input.userAgent?.slice(0, 500),
    })
    .then(
      () => {},
      (error) => logger.error({ error, path: input.path }, 'Failed to record admin access'),
    );
}
