import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/require-platform-admin';
import { adminService } from '../services/admin.service';
import { abuseService, AUP_CLAUSES, type AupClause } from '../services/abuse.service';
import { userBanService } from '../services/user-ban.service';
import { getPlatformVersion } from '../lib/platform-version';
import { t } from '../i18n';
import type { AppEnv } from '../types';

/**
 * Platform-operator API — cross-organisation, read-only views of who signed up and what they
 * did. Plain Hono rather than OpenAPI on purpose: this is not part of the public API surface
 * and should not appear in the Swagger document. (The platform version route is declared with
 * createRoute for its schema, but `hide: true` and this plain router keep it out of the document.)
 */
const adminRouter = new Hono<AppEnv>();

// Both gates are registered once, here, for every route in this file — a new endpoint cannot
// be added without them. admin.test.ts walks the route table to prove it.
adminRouter.use('*', authMiddleware);
adminRouter.use('*', requirePlatformAdmin);

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const userListSchema = pageSchema.extend({
  search: z.string().trim().max(200).default(''),
  sort: z.enum(['newest', 'last_seen', 'most_active']).default('newest'),
  filter: z.enum(['all', 'unverified', 'no_project', 'failing']).default('all'),
});

const uuidSchema = z.string().uuid();

function parseQuery<T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): z.infer<T> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new HTTPException(400, { message: t(c.get('locale'), 'errors', 'badRequest') });
  }
  return parsed.data;
}

adminRouter.get('/overview', async (c) => {
  return c.json({ data: await adminService.getOverview() });
});

adminRouter.get('/users', async (c) => {
  const query = parseQuery(c, userListSchema);
  return c.json({ data: await adminService.listUsers(query) });
});

adminRouter.get('/users/:userId', async (c) => {
  const id = uuidSchema.safeParse(c.req.param('userId'));
  const detail = id.success ? await adminService.getUserDetail(id.data) : null;
  if (!detail) {
    throw new HTTPException(404, { message: t(c.get('locale'), 'auth', 'userNotFound') });
  }
  return c.json({ data: detail });
});

adminRouter.get('/activity', async (c) => {
  const query = parseQuery(c, pageSchema);
  return c.json({ data: await adminService.listActivity(query) });
});

adminRouter.get('/auth-events', async (c) => {
  const query = parseQuery(c, pageSchema);
  return c.json({ data: await adminService.listAuthEvents(query) });
});

// ── Platform version / update check ──────────────────────────────────────────

const platformVersionRoute = createRoute({
  method: 'get',
  path: '/version',
  // Listing it would tell anyone reading /api/v1/doc that the admin panel exists (see above).
  hide: true,
  tags: ['Admin'],
  summary: 'Running version and whether a newer or security release exists',
  description:
    'Compares the running version (package.json) with the GitHub releases of pushifydev/pushify_backend, ' +
    'cached for 6 hours. `securityRelease` is true when a release newer than `current` is marked as a ' +
    'security release. Always 200: when the check is turned off (PUSHIFY_DISABLE_UPDATE_CHECK=true) or ' +
    'GitHub cannot be reached, `latest` is null and `check` says why. Update with selfhost/update.sh.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Version status',
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              current: z.string().nullable(),
              latest: z
                .object({
                  version: z.string(),
                  tag: z.string(),
                  name: z.string().nullable(),
                  url: z.string().nullable(),
                  publishedAt: z.string().nullable(),
                })
                .nullable(),
              updateAvailable: z.boolean(),
              securityRelease: z.boolean(),
              check: z.enum(['ok', 'disabled', 'unavailable']),
              checkedAt: z.string().nullable(),
            }),
          }),
        },
      },
    },
  },
});

const platformRouter = new OpenAPIHono<AppEnv>();
platformRouter.openapi(platformVersionRoute, async (c) => c.json({ data: await getPlatformVersion() }, 200));
adminRouter.route('/platform', platformRouter);

// ── Acceptable Use review queue ──────────────────────────────────────────────

const flagListSchema = pageSchema.extend({
  status: z.enum(['open', 'dismissed', 'actioned', 'all']).default('open'),
});

const suspendSchema = z.object({
  reason: z.string().trim().min(10).max(2000),
  clause: z.enum(Object.keys(AUP_CLAUSES) as [AupClause, ...AupClause[]]),
  /** Days until the suspension lapses for review; null = until an appeal is resolved */
  days: z.number().int().min(1).max(365).nullable().default(null),
  flagId: z.string().uuid().nullable().optional(),
});

const noteSchema = z.object({ note: z.string().trim().max(2000).nullable().optional() });

async function parseBody<T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new HTTPException(400, { message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  }
  return parsed.data;
}

function uuidParam(c: Context<AppEnv>, name: string): string {
  const id = uuidSchema.safeParse(c.req.param(name));
  if (!id.success) throw new HTTPException(404, { message: 'Not found' });
  return id.data;
}

adminRouter.get('/abuse/flags', async (c) => {
  const query = parseQuery(c, flagListSchema);
  return c.json({ data: await abuseService.listFlags(query) });
});

adminRouter.get('/abuse/clauses', async (c) => c.json({ data: await abuseService.clauses() }));

adminRouter.post('/abuse/flags/:flagId/dismiss', async (c) => {
  const { note } = await parseBody(c, noteSchema);
  await abuseService.dismissFlag(uuidParam(c, 'flagId'), c.get('userId')!, note ?? null);
  return c.json({ data: { ok: true } });
});

// Approve an owner's review request (source review_request): lifts the suspension and clears the
// rules that stopped the deploy for the project. Declining is the dismiss above.
adminRouter.post('/abuse/flags/:flagId/approve-review', async (c) => {
  const { note } = await parseBody(c, noteSchema);
  const result = await abuseService.approveReviewRequest(uuidParam(c, 'flagId'), c.get('userId')!, note ?? null);
  return c.json({ data: result });
});

adminRouter.post('/abuse/projects/:projectId/suspend', async (c) => {
  const body = await parseBody(c, suspendSchema);
  const result = await abuseService.suspendProject({
    projectId: uuidParam(c, 'projectId'),
    adminUserId: c.get('userId')!,
    reason: body.reason,
    clause: body.clause,
    endsAt: body.days ? new Date(Date.now() + body.days * 86_400_000) : null,
    flagId: body.flagId ?? null,
  });
  return c.json({ data: result });
});

adminRouter.post('/abuse/projects/:projectId/unsuspend', async (c) => {
  const { note } = await parseBody(c, noteSchema);
  const result = await abuseService.unsuspendProject({
    projectId: uuidParam(c, 'projectId'),
    adminUserId: c.get('userId')!,
    note: note ?? null,
  });
  return c.json({ data: result });
});

const banSchema = z.object({
  reason: z.string().trim().min(10).max(2000),
  clause: z.enum(Object.keys(AUP_CLAUSES) as [AupClause, ...AupClause[]]).default('proxy-vpn'),
});

adminRouter.post('/users/:userId/ban', async (c) => {
  const body = await parseBody(c, banSchema);
  const result = await userBanService.banUser({
    userId: uuidParam(c, 'userId'),
    adminUserId: c.get('userId')!,
    reason: body.reason,
    clause: body.clause,
  });
  return c.json({ data: result });
});

adminRouter.post('/users/:userId/unban', async (c) => {
  const { note } = await parseBody(c, noteSchema);
  const result = await userBanService.unbanUser({ userId: uuidParam(c, 'userId'), adminUserId: c.get('userId')!, note: note ?? null });
  return c.json({ data: result });
});

adminRouter.get('/abuse/projects/:projectId/actions', async (c) => {
  return c.json({ data: await abuseService.listActions([uuidParam(c, 'projectId')]) });
});

export { adminRouter as adminRoutes };
