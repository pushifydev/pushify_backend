import { Hono } from 'hono';
import { previewService } from '../services/preview.service';
import { authMiddleware } from '../middleware/auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';

const previewRouter = new Hono<AppEnv>();

// All routes require authentication
previewRouter.use('*', authMiddleware);

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

export { previewRouter as previewRoutes };
