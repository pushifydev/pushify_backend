import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { requireMinRole } from '../lib/org-access';
import { activityService } from '../services/activity.service';
import { combinedAuthMiddleware } from '../middleware/auth';
import type { ActivityAction } from '../db/schema/activity';
import type { AppEnv } from '../types';
import { AUDIT_SOURCES, type AuditSource } from '../lib/audit';

// ============ Schemas ============

const ActivityActionEnum = z.enum([
  'project.created',
  'project.updated',
  'project.deleted',
  'project.paused',
  'project.resumed',
  'project.suspended',
  'project.unsuspended',
  'deployment.created',
  'deployment.cancelled',
  'deployment.redeployed',
  'deployment.rolledback',
  'deployment.succeeded',
  'deployment.failed',
  'envvar.created',
  'envvar.updated',
  'envvar.deleted',
  'domain.added',
  'domain.removed',
  'domain.verified',
  'domain.set_primary',
  'domain.nginx_updated',
  'apikey.created',
  'apikey.revoked',
  'member.invited',
  'member.removed',
  'member.role_changed',
  'settings.updated',
  'webhook.regenerated',
  'notification.channel_created',
  'notification.channel_updated',
  'notification.channel_deleted',
  'healthcheck.enabled',
  'healthcheck.disabled',
  'healthcheck.updated',
  'database.data_modified',
  'database.query_executed',
  'database.schema_changed',
]);

const UserSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
}).nullable();

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
}).nullable();

const ActivityLogSchema = z.object({
  id: z.string(),
  action: ActivityActionEnum,
  description: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  /** Where the action came from; null for entries recorded before this was tracked */
  source: z.enum(AUDIT_SOURCES).nullable(),
  /** Field-level diff. Secret values appear only as { changed: true }, never in clear. */
  changes: z
    .record(
      z.string(),
      z.union([z.object({ from: z.unknown(), to: z.unknown() }), z.object({ changed: z.literal(true) })])
    )
    .nullable(),
  createdAt: z.coerce.date(),
  user: UserSchema,
  project: ProjectSchema,
}).openapi('ActivityLog');

function isAuditSource(value: string): value is AuditSource {
  return (AUDIT_SOURCES as readonly string[]).includes(value);
}

/** Comma-separated `source` query value -> known sources (unknown values dropped). */
function parseSources(value: string | undefined): AuditSource[] | undefined {
  const sources = value?.split(',').map((s) => s.trim()).filter(isAuditSource);
  return sources && sources.length > 0 ? sources : undefined;
}

/** Optional ISO date query value -> Date; null when present but unparseable. */
function parseDate(value: string | undefined): Date | undefined | null {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ============ Route Definitions ============

const listActivityLogsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Activity'],
  summary: 'List activity logs',
  description:
    'Audit log of the current organization (admin/owner only). Filter by project, user, ' +
    'action, source (ui, api, webhook, system) and date range (`from`/`to`, inclusive ISO 8601). ' +
    'Paginated with `limit`/`offset`. Secret values are never returned; changed secrets appear as ' +
    '`{ changed: true }`.',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      projectId: z.string().uuid().optional(),
      userId: z.string().uuid().optional(),
      actions: z.string().optional(), // comma-separated actions
      // comma-separated sources: ui, api, webhook, system
      source: z
        .string()
        .optional()
        .refine((v) => !v || v.split(',').filter(Boolean).every((s) => isAuditSource(s)), {
          message: `source must be a comma-separated list of: ${AUDIT_SOURCES.join(', ')}`,
        }),
      // ISO 8601 date-time bounds (inclusive) on when the entry was recorded
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Activity logs',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(ActivityLogSchema),
            total: z.number(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid filter (e.g. `from` after `to`)',
      content: { 'application/json': { schema: z.object({ message: z.string() }) } },
    },
  },
});

// ============ Router ============

const activityRouter = new OpenAPIHono<AppEnv>();

// All routes require authentication
activityRouter.use('*', combinedAuthMiddleware);
// The organization's audit trail (who did what, from which IP): admins and owners.
activityRouter.use('*', requireMinRole('admin'));

// List activity logs
activityRouter.openapi(listActivityLogsRoute, async (c) => {
  const organizationId = c.get('organizationId')!;
  const { projectId, userId, actions: actionsStr, source, from, to, limit, offset } = c.req.valid('query');
  if (from && to && new Date(from) > new Date(to)) {
    return c.json({ message: 'from must be before or equal to to' }, 400);
  }

  // Parse actions filter
  const actions = actionsStr?.split(',').filter(Boolean) as ActivityAction[] | undefined;

  const { logs, total } = await activityService.getByOrganization(organizationId, {
    projectId,
    userId,
    actions,
    sources: parseSources(source),
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
    limit: limit ?? 50,
    offset: offset ?? 0,
  });

  return c.json({ data: logs, total }, 200);
});

/**
 * The same log as a CSV file. Compliance reviews ask for the audit trail as evidence, and
 * scrolling a dashboard is not evidence. Outside the OpenAPI document because it answers with a
 * file rather than JSON.
 */
activityRouter.get('/export', async (c) => {
  const organizationId = c.get('organizationId')!;
  const actions = c.req.query('actions')?.split(',').filter(Boolean) as ActivityAction[] | undefined;
  const from = parseDate(c.req.query('from'));
  const to = parseDate(c.req.query('to'));
  if (from === null || to === null) {
    return c.json({ message: 'from/to must be ISO 8601 date-times' }, 400);
  }
  if (from && to && from > to) {
    return c.json({ message: 'from must be before or equal to to' }, 400);
  }

  const { logs } = await activityService.getByOrganization(organizationId, {
    projectId: c.req.query('projectId'),
    userId: c.req.query('userId'),
    actions,
    sources: parseSources(c.req.query('source')),
    from,
    to,
    limit: 10_000,
    offset: 0,
  });

  const { toCsvRows } = await import('../lib/csv');
  const body = toCsvRows(
    ['time', 'action', 'description', 'user', 'user_email', 'project', 'ip_address', 'metadata', 'source', 'changes'],
    logs
      .slice()
      .reverse()
      .map((log) => [
        log.createdAt.toISOString(),
        log.action,
        log.description,
        log.user?.name ?? '',
        log.user?.email ?? '',
        log.project?.name ?? '',
        log.ipAddress ?? '',
        log.metadata,
        log.source ?? '',
        log.changes ?? '',
      ])
  );

  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header(
    'Content-Disposition',
    `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  return c.body(body);
});

export { activityRouter as activityRoutes };
