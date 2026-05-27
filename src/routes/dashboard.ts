import { Hono } from 'hono';
import { dashboardService } from '../services/dashboard.service';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv } from '../types';

const dashboardRouter = new Hono<AppEnv>();

dashboardRouter.use('*', authMiddleware);

dashboardRouter.get('/overview', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const overview = await dashboardService.getOverview(organizationId, userId, locale);

  return c.json({ data: overview });
});

export { dashboardRouter as dashboardRoutes };
