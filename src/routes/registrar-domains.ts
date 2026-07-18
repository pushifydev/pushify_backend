import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { MAX_PURCHASE_YEARS, registrarDomainService } from '../services/registrar-domain.service';
import { billingService } from '../services/billing.service';
import { stripeService } from '../services/stripe.service';
import { t } from '../i18n';
import type { AppEnv } from '../types';

/** Domain sales (registrar reseller) — /api/v1/domains */
const registrarDomainRoutes = new Hono<AppEnv>();

registrarDomainRoutes.use('*', authMiddleware);

// Feature discovery for the dashboard (hidden when no registrar is configured)
registrarDomainRoutes.get('/config', (c) => {
  return c.json({ data: { enabled: registrarDomainService.isConfigured() } });
});

registrarDomainRoutes.get('/search', async (c) => {
  const locale = c.get('locale');
  const query = c.req.query('q') ?? '';
  const results = await registrarDomainService.search(query, locale);
  return c.json({ data: results });
});

registrarDomainRoutes.get('/', async (c) => {
  const organizationId = c.get('organizationId')!;
  const domains = await registrarDomainService.listByOrganization(organizationId);
  return c.json({ data: domains });
});

const purchaseSchema = z.object({
  domainName: z.string().min(4).max(253),
  projectId: z.string().uuid().optional(),
  years: z.number().int().min(1).max(MAX_PURCHASE_YEARS).optional(),
});

registrarDomainRoutes.post('/purchase', async (c) => {
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');

  const body = purchaseSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
  }

  const result = await registrarDomainService.purchase({
    organizationId,
    userId,
    domainName: body.data.domainName,
    years: body.data.years,
    projectId: body.data.projectId,
    locale,
  });
  return c.json({ data: result }, 201);
});

// Card payment path: quote → Stripe Checkout; the webhook registers the domain on payment
registrarDomainRoutes.post('/purchase/checkout', async (c) => {
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const locale = c.get('locale');

  const body = purchaseSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
  }

  const years = body.data.years ?? 1;
  const quote = await registrarDomainService.quote(body.data.domainName, years, locale);
  const billingInfo = await billingService.getBillingInfo(organizationId, userId, locale);

  const url = await stripeService.createDomainPurchaseSession({
    organizationId,
    userId,
    email: billingInfo.billingEmail || '',
    domainName: quote.domainName,
    years,
    amountCents: quote.retailTotalCents,
    projectId: body.data.projectId,
    locale,
  });
  return c.json({ data: { url, amountCents: quote.retailTotalCents } });
});

const autoRenewSchema = z.object({ enabled: z.boolean() });

registrarDomainRoutes.patch('/:domainName/auto-renew', async (c) => {
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const domainName = c.req.param('domainName');

  const body = autoRenewSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
  }

  const updated = await registrarDomainService.setAutoRenew(
    organizationId,
    domainName,
    body.data.enabled,
    locale
  );
  return c.json({ data: updated });
});

export { registrarDomainRoutes };
