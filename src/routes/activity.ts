import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { activityService } from '../services/activity.service';
import { combinedAuthMiddleware } from '../middleware/auth';
import type { ActivityAction } from '../db/schema/activity';
import type { AppEnv } from '../types';

// ============ Schemas ============

const ActivityActionEnum = z.enum([
  'project.created',
  'project.updated',
  'project.deleted',
  'project.paused',
  'project.resumed',
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
  createdAt: z.coerce.date(),
  user: UserSchema,
  project: ProjectSchema,
}).openapi('ActivityLog');

// ============ Route Definitions ============

const listActivityLogsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Activity'],
  summary: 'List activity logs',
  description: 'Get activity logs for the current organization',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      projectId: z.string().uuid().optional(),
      userId: z.string().uuid().optional(),
      actions: z.string().optional(), // comma-separated actions
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
  },
});

// ============ Router ============

const activityRouter = new OpenAPIHono<AppEnv>();

// All routes require authentication
activityRouter.use('*', combinedAuthMiddleware);

// List activity logs
activityRouter.openapi(listActivityLogsRoute, async (c) => {
  const organizationId = c.get('organizationId')!;
  const { projectId, userId, actions: actionsStr, limit, offset } = c.req.valid('query');

  // Parse actions filter
  const actions = actionsStr?.split(',').filter(Boolean) as ActivityAction[] | undefined;

  const { logs, total } = await activityService.getByOrganization(organizationId, {
    projectId,
    userId,
    actions,
    limit: limit ?? 50,
    offset: offset ?? 0,
  });

  return c.json({ data: logs, total });
});

export { activityRouter as activityRoutes };
