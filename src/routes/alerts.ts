import { Hono } from 'hono';
import { alertsService } from '../services/alerts.service';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv } from '../types';

const alertsRouter = new Hono<AppEnv>();

alertsRouter.use('*', authMiddleware);

alertsRouter.get('/overview', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const overview = await alertsService.getOverview(organizationId, userId, locale);

  return c.json({ data: overview });
});

export { alertsRouter as alertsRoutes };
