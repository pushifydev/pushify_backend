import { Hono } from 'hono';
import { healthCheckService } from '../services/healthcheck.service';
import { authMiddleware } from '../middleware/auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';

const healthCheckRouter = new Hono<AppEnv>();

// All routes require authentication
healthCheckRouter.use('*', authMiddleware);

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
  const body = await c.req.json();

  const config = await healthCheckService.upsertConfig(
    projectId,
    organizationId,
    userId,
    body,
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
