import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/require-platform-admin';
import { adminService } from '../services/admin.service';
import { abuseService, AUP_CLAUSES, type AupClause } from '../services/abuse.service';
import { t } from '../i18n';
import type { AppEnv } from '../types';

/**
 * Platform-operator API — cross-organisation, read-only views of who signed up and what they
 * did. Plain Hono rather than OpenAPI on purpose: this is not part of the public API surface
 * and should not appear in the Swagger document.
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

adminRouter.get('/abuse/projects/:projectId/actions', async (c) => {
  return c.json({ data: await abuseService.listActions([uuidParam(c, 'projectId')]) });
});

export { adminRouter as adminRoutes };
