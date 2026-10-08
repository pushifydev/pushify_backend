import { Hono } from 'hono';
import { requireScope } from '../middleware/apikey-auth';
import { getMemberAllowedProjectIds } from '../lib/member-project-scope';
import { requireOrgMember } from '../lib/org-access';
import { metricsService } from '../services/metrics.service';
import { trafficAnalyticsService } from '../services/traffic-analytics.service';
import { parseTrafficRange } from '../lib/traffic-analytics';
import { projectRepository } from '../repositories/project.repository';
import { authMiddleware } from '../middleware/auth';
import { t, type SupportedLocale } from '../i18n';
import { organizationRepository } from '../repositories/organization.repository';
import { assertMemberProjectScope } from '../lib/member-project-scope';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../types';

const metricsRouter = new Hono<AppEnv>();

// All routes require authentication
metricsRouter.use('*', authMiddleware);
metricsRouter.use('/overview', requireScope('metrics:read'));
metricsRouter.use('/:projectId/metrics', requireScope('metrics:read'));
metricsRouter.use('/:projectId/metrics/*', requireScope('metrics:read'));
metricsRouter.use('/:projectId/analytics', requireScope('metrics:read'));

/**
 * Verify project access
 */
async function verifyProjectAccess(
  projectId: string,
  organizationId: string,
  userId: string,
  locale: SupportedLocale
): Promise<void> {
  const project = await projectRepository.findById(projectId);

  if (!project) {
    throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
  }

  if (project.organizationId !== organizationId) {
    throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
  }

  const membership = await organizationRepository.findMember(organizationId, userId);
  if (!membership) {
    throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
  }

  await assertMemberProjectScope(membership, organizationId, userId, projectId, locale);
}

// Get metrics overview for all projects in the organization
metricsRouter.get('/overview', async (c) => {
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const membership = await requireOrgMember(organizationId, userId, 'viewer', c.get('locale'));
  const allowed = await getMemberAllowedProjectIds(membership, organizationId, userId);
  const overview = await metricsService.getMetricsOverview(organizationId, allowed);
  return c.json({ data: overview });
});

// Get metrics summary for a project
metricsRouter.get('/:projectId/metrics', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  await verifyProjectAccess(projectId, organizationId, c.get('userId')!, locale);

  const summary = await metricsService.getMetricsSummary(projectId);

  return c.json({ data: summary });
});

// Get time series data for charts
metricsRouter.get('/:projectId/metrics/timeseries', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  await verifyProjectAccess(projectId, organizationId, c.get('userId')!, locale);

  // Get hours from query param (default 1 hour)
  const hoursParam = c.req.query('hours');
  const hours = hoursParam ? Math.min(parseInt(hoursParam) || 1, 24) : 1;

  const timeSeries = await metricsService.getTimeSeriesData(projectId, hours);

  return c.json({ data: timeSeries });
});

// Hourly traffic for an app: requests, 4xx/5xx and bytes sent (?range=24h|7d, default 24h)
metricsRouter.get('/:projectId/analytics', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  await verifyProjectAccess(projectId, organizationId, c.get('userId')!, locale);

  const range = parseTrafficRange(c.req.query('range'));
  if (!range) {
    throw new HTTPException(400, { message: 'range must be one of: 24h, 7d' });
  }

  const analytics = await trafficAnalyticsService.getProjectAnalytics(projectId, range);
  return c.json({ data: analytics });
});

export { metricsRouter as metricsRoutes };
