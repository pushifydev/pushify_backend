import { Hono } from 'hono';
import { metricsService } from '../services/metrics.service';
import { projectRepository } from '../repositories/project.repository';
import { authMiddleware } from '../middleware/auth';
import { t, type SupportedLocale } from '../i18n';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../types';

const metricsRouter = new Hono<AppEnv>();

// All routes require authentication
metricsRouter.use('*', authMiddleware);

/**
 * Verify project access
 */
async function verifyProjectAccess(
  projectId: string,
  organizationId: string,
  locale: SupportedLocale
): Promise<void> {
  const project = await projectRepository.findById(projectId);

  if (!project) {
    throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
  }

  if (project.organizationId !== organizationId) {
    throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
  }
}

// Get metrics overview for all projects in the organization
metricsRouter.get('/overview', async (c) => {
  const organizationId = c.get('organizationId')!;
  const overview = await metricsService.getMetricsOverview(organizationId);
  return c.json({ data: overview });
});

// Get metrics summary for a project
metricsRouter.get('/:projectId/metrics', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  await verifyProjectAccess(projectId, organizationId, locale);

  const summary = await metricsService.getMetricsSummary(projectId);

  return c.json({ data: summary });
});

// Get time series data for charts
metricsRouter.get('/:projectId/metrics/timeseries', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  await verifyProjectAccess(projectId, organizationId, locale);

  // Get hours from query param (default 1 hour)
  const hoursParam = c.req.query('hours');
  const hours = hoursParam ? Math.min(parseInt(hoursParam) || 1, 24) : 1;

  const timeSeries = await metricsService.getTimeSeriesData(projectId, hours);

  return c.json({ data: timeSeries });
});

export { metricsRouter as metricsRoutes };
