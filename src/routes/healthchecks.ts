import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { requireScopeByMethod } from '../middleware/apikey-auth';
import { healthCheckService } from '../services/healthcheck.service';
import { authMiddleware } from '../middleware/auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';

const healthCheckRouter = new Hono<AppEnv>();

// Only these fields are accepted; anything else (projectId, id, createdAt, …) is dropped.
const healthCheckConfigSchema = z.object({
  endpoint: z.string().startsWith('/').max(500).optional(),
  intervalSeconds: z.number().int().min(10).max(3600).optional(),
  timeoutSeconds: z.number().int().min(1).max(60).optional(),
  unhealthyThreshold: z.number().int().min(1).max(20).optional(),
  autoRestart: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

// All routes require authentication
healthCheckRouter.use('*', authMiddleware);
healthCheckRouter.use('/:projectId/health-check', requireScopeByMethod('projects:read', 'projects:write', 'projects:delete'));
healthCheckRouter.use('/:projectId/health-check/*', requireScopeByMethod('projects:read', 'projects:write', 'projects:delete'));
healthCheckRouter.use('/:projectId/health-status', requireScopeByMethod('projects:read', 'projects:write', 'projects:delete'));

// What monitoring last saw (status badge on the project page)
healthCheckRouter.get('/:projectId/health-status', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  const status = await healthCheckService.getStatus(projectId, organizationId, userId, locale);
  return c.json({ data: status });
});

// Get health check config for a project
healthCheckRouter.get('/:projectId/health-check', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  const config = await healthCheckService.getConfig(
    projectId,
    organizationId,
    userId,
    locale
  );

  return c.json({ data: config });
});

// Create or update health check config
healthCheckRouter.put('/:projectId/health-check', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const body = healthCheckConfigSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    throw new HTTPException(400, { message: t(locale, 'validation', 'invalidRequest') });
  }

  const config = await healthCheckService.upsertConfig(
    projectId,
    organizationId,
    userId,
    body.data,
    locale
  );

  return c.json({
    data: config,
    message: t(locale, 'healthChecks', 'updated'),
  });
});

// Delete health check config (disable health checks)
healthCheckRouter.delete('/:projectId/health-check', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  await healthCheckService.deleteConfig(
    projectId,
    organizationId,
    userId,
    locale
  );

  return c.json({ message: t(locale, 'healthChecks', 'disabled') });
});

// Get health check logs for a project
healthCheckRouter.get('/:projectId/health-check/logs', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  const logs = await healthCheckService.getLogs(
    projectId,
    organizationId,
    userId,
    locale
  );

  return c.json({ data: logs });
});

export { healthCheckRouter as healthCheckRoutes };
