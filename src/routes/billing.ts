import { Hono } from 'hono';
import { billingService } from '../services/billing.service';
import { stripeService } from '../services/stripe.service';
import { authMiddleware } from '../middleware/auth';
import { env } from '../config/env';
import { t } from '../i18n';
import type { AppEnv } from '../types';
import type { PlanType } from '../lib/plans';

const billingRouter = new Hono<AppEnv>();

// Public: Get available plans (no auth required)
billingRouter.get('/plans', async (c) => {
  const plans = billingService.getAvailablePlans();
  return c.json({ data: plans });
});

// All remaining routes require authentication
billingRouter.use('*', authMiddleware);

// Get billing information
billingRouter.get('/', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const billingInfo = await billingService.getBillingInfo(organizationId, userId, locale);

  return c.json({ data: billingInfo });
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

// Create Stripe Checkout session
billingRouter.post('/checkout', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  if (!env.STRIPE_SECRET_KEY) {
    return c.json({ error: { code: 'STRIPE_NOT_CONFIGURED', message: t(locale, 'billing', 'stripeNotConfigured') } }, 400);
  }

  const { planType, billingCycle } = await c.req.json<{ planType: PlanType; billingCycle: 'monthly' | 'yearly' }>();

  if (!planType || !['hobby', 'pro', 'business'].includes(planType)) {
    return c.json({ error: { code: 'INVALID_PLAN', message: 'Invalid plan type' } }, 400);
  }

  if (!billingCycle || !['monthly', 'yearly'].includes(billingCycle)) {
    return c.json({ error: { code: 'INVALID_CYCLE', message: 'Invalid billing cycle' } }, 400);
  }

  const billingInfo = await billingService.getBillingInfo(organizationId, userId, locale);
  const email = billingInfo.billingEmail || '';

  const url = await stripeService.createCheckoutSession(organizationId, userId, email, planType, billingCycle);

  return c.json({ data: { url } });
});

// Create Stripe Customer Portal session
billingRouter.post('/portal', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  if (!env.STRIPE_SECRET_KEY) {
    return c.json({ error: { code: 'STRIPE_NOT_CONFIGURED', message: t(locale, 'billing', 'stripeNotConfigured') } }, 400);
  }

  const url = await stripeService.createPortalSession(organizationId);

  return c.json({ data: { url } });
});

// Get subscription status
billingRouter.get('/subscription', async (c) => {
  const organizationId = c.get('organizationId')!;

  const status = await stripeService.getSubscriptionStatus(organizationId);

  return c.json({ data: status });
});

// Cancel subscription
billingRouter.post('/cancel', async (c) => {
  const organizationId = c.get('organizationId')!;

  await stripeService.cancelSubscription(organizationId);

  return c.json({ message: 'Subscription will be cancelled at the end of the billing period' });
});

// Resume cancelled subscription
billingRouter.post('/resume', async (c) => {
  const organizationId = c.get('organizationId')!;

  await stripeService.resumeSubscription(organizationId);

  return c.json({ message: 'Subscription resumed' });
});

export { billingRouter as billingRoutes };
