import { Hono } from 'hono';
import { requireScopeByMethod } from '../middleware/apikey-auth';
import { previewService } from '../services/preview.service';
import { activityService } from '../services/activity.service';
import { authMiddleware } from '../middleware/auth';
import { auditSource } from '../lib/audit';
import { t } from '../i18n';
import type { AppEnv } from '../types';

const previewRouter = new Hono<AppEnv>();

// All routes require authentication
previewRouter.use('*', authMiddleware);
previewRouter.use('/:projectId/previews', requireScopeByMethod('projects:read', 'projects:write'));
previewRouter.use('/:projectId/previews/*', requireScopeByMethod('projects:read', 'projects:write'));

// Get all preview deployments for a project
previewRouter.get('/:projectId/previews', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  const previews = await previewService.getPreviewsByProject(
    projectId,
    organizationId,
    userId,
    locale
  );

  return c.json({ data: previews });
});

// Get active preview deployments for a project
previewRouter.get('/:projectId/previews/active', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  const previews = await previewService.getActivePreviewsByProject(
    projectId,
    organizationId,
    userId,
    locale
  );

  return c.json({ data: previews });
});

// Redeploy an open preview from the head of its PR branch (member and up)
previewRouter.post('/:projectId/previews/:previewId/redeploy', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const previewId = c.req.param('previewId');

  const preview = await previewService.redeployPreview(projectId, previewId, organizationId, userId, locale);

  await activityService.log({
    organizationId,
    userId,
    projectId,
    action: 'preview.redeployed',
    description: `Redeployed preview of PR #${preview.prNumber}`,
    metadata: { previewId: preview.id, prNumber: preview.prNumber, deploymentId: preview.deploymentId },
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
    source: auditSource(c),
  });

  return c.json({ data: preview, message: t(locale, 'previews', 'redeployStarted') }, 201);
});

// Close a preview by hand: same teardown as the PR-closed webhook (member and up)
previewRouter.post('/:projectId/previews/:previewId/close', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const previewId = c.req.param('previewId');

  const preview = await previewService.closePreview(projectId, previewId, organizationId, userId, locale);

  await activityService.log({
    organizationId,
    userId,
    projectId,
    action: 'preview.closed',
    description: `Closed preview of PR #${preview.prNumber}`,
    metadata: { previewId: preview.id, prNumber: preview.prNumber },
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
    source: auditSource(c),
  });

  return c.json({ data: preview, message: t(locale, 'previews', 'closed') });
});

export { previewRouter as previewRoutes };
