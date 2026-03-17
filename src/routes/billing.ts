import { Hono } from 'hono';
import { billingService } from '../services/billing.service';
import { authMiddleware } from '../middleware/auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';

const billingRouter = new Hono<AppEnv>();

// All routes require authentication
billingRouter.use('*', authMiddleware);

// Get billing information
billingRouter.get('/', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const billingInfo = await billingService.getBillingInfo(organizationId, userId, locale);

  return c.json({ data: billingInfo });
});

// Get available plans
billingRouter.get('/plans', async (c) => {
  const plans = billingService.getAvailablePlans();
  return c.json({ data: plans });
});

// Update billing email
billingRouter.patch('/email', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { billingEmail } = await c.req.json();

  await billingService.updateBillingEmail(organizationId, userId, billingEmail, locale);

  return c.json({
    message: t(locale, 'billing', 'emailUpdated'),
  });
});

export { billingRouter as billingRoutes };
