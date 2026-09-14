import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/require-platform-admin';
import { adminService } from '../services/admin.service';
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

export { adminRouter as adminRoutes };
