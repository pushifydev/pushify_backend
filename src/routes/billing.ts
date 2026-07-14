import { Hono } from 'hono';
import { billingService } from '../services/billing.service';
import { stripeService } from '../services/stripe.service';
import { infraBillingService } from '../services/infra-billing.service';
import { INFRA_TOPUP_AMOUNTS_CENTS } from '../lib/infra-billing';
import { authMiddleware } from '../middleware/auth';
import { requireOrgRole } from '../middleware/require-role';
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
billingRouter.post('/checkout', requireOrgRole('owner', 'admin'), async (c) => {
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
billingRouter.post('/portal', requireOrgRole('owner', 'admin'), async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  if (!env.STRIPE_SECRET_KEY) {
    return c.json({ error: { code: 'STRIPE_NOT_CONFIGURED', message: t(locale, 'billing', 'stripeNotConfigured') } }, 400);
  }

  const url = await stripeService.createPortalSession(organizationId);

  return c.json({ data: { url } });
});

// Get subscription status
billingRouter.get('/invoices', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const invoices = await billingService.listInvoices(organizationId, userId, locale);
  return c.json({ data: invoices });
});

billingRouter.get('/subscription', async (c) => {
  const organizationId = c.get('organizationId')!;

  const status = await stripeService.getSubscriptionStatus(organizationId);

  return c.json({ data: status });
});

// Cancel subscription
billingRouter.post('/cancel', requireOrgRole('owner', 'admin'), async (c) => {
  const organizationId = c.get('organizationId')!;

  await stripeService.cancelSubscription(organizationId);

  return c.json({ message: 'Subscription will be cancelled at the end of the billing period' });
});

// Resume cancelled subscription
billingRouter.post('/resume', requireOrgRole('owner', 'admin'), async (c) => {
  const organizationId = c.get('organizationId')!;

  await stripeService.resumeSubscription(organizationId);

  return c.json({ message: 'Subscription resumed' });
});

// Infrastructure wallet (managed Hetzner billing)
billingRouter.get('/infra', async (c) => {
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');

  await billingService.getBillingInfo(organizationId, userId, locale);

  await infraBillingService.clearInfraCreditsStoppedMessages(organizationId);

  const wallet = await infraBillingService.getWalletSummary(organizationId);
  const transactions = await infraBillingService.listTransactions(organizationId, 30);

  return c.json({
    data: {
      wallet,
      transactions: transactions.map((tx) => ({
        id: tx.id,
        type: tx.type,
        amountCents: tx.amountCents,
        balanceAfterCents: tx.balanceAfterCents,
        description: tx.description,
        serverId: tx.serverId,
        createdAt: tx.createdAt.toISOString(),
      })),
    },
  });
});

billingRouter.post('/infra/topup', requireOrgRole('owner', 'admin'), async (c) => {
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');

  if (!env.STRIPE_SECRET_KEY) {
    return c.json(
      { error: { code: 'STRIPE_NOT_CONFIGURED', message: t(locale, 'billing', 'stripeNotConfigured') } },
      400,
    );
  }

  const { amountCents } = await c.req.json<{ amountCents: number }>();

  if (!amountCents || !INFRA_TOPUP_AMOUNTS_CENTS.includes(amountCents as (typeof INFRA_TOPUP_AMOUNTS_CENTS)[number])) {
    return c.json(
      { error: { code: 'INVALID_AMOUNT', message: t(locale, 'infraBilling', 'invalidTopUpAmount') } },
      400,
    );
  }

  const billingInfo = await billingService.getBillingInfo(organizationId, userId, locale);
  const email = billingInfo.billingEmail || '';

  try {
    const url = await stripeService.createInfraTopUpSession(
      organizationId,
      userId,
      email,
      amountCents,
    );
    return c.json({ data: { url } });
  } catch (err) {
    if (err instanceof Error && err.message === 'INVALID_TOPUP_AMOUNT') {
      return c.json(
        { error: { code: 'INVALID_AMOUNT', message: t(locale, 'infraBilling', 'invalidTopUpAmount') } },
        400,
      );
    }
    throw err;
  }
});

/** Confirm infra top-up after Stripe redirect (works without webhook, e.g. local dev). */
billingRouter.post('/infra/confirm', requireOrgRole('owner', 'admin'), async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  if (!env.STRIPE_SECRET_KEY) {
    return c.json(
      { error: { code: 'STRIPE_NOT_CONFIGURED', message: t(locale, 'billing', 'stripeNotConfigured') } },
      400,
    );
  }

  const { sessionId } = await c.req.json<{ sessionId: string }>();
  if (!sessionId?.trim()) {
    return c.json({ error: { code: 'INVALID_SESSION', message: 'Missing sessionId' } }, 400);
  }

  try {
    const result = await stripeService.confirmInfraTopUp(organizationId, sessionId.trim());
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof Error && err.message === 'CHECKOUT_ORG_MISMATCH') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Checkout session does not belong to this organization' } }, 403);
    }
    throw err;
  }
});

export { billingRouter as billingRoutes };
